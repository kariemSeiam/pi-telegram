// src/telegram/cron-ui.ts — cron menu, cron input handling, cron directive execution
import { Menu } from "@grammyjs/menu";
import { log } from "../shared/log.js";
import type { CronSchedule, CronJobRecord } from "../cron/types.js";
import type { TgCronDirective } from "../cron/directives.js";
import { extractTgCronDirectives } from "../cron/directives.js";
import type {
	BotContext,
	CronPendingInput,
	SharedBotState,
} from "./bot-context.js";
import type { TgAttachment, TgAttachmentKind } from "./attachment.js";
import { rememberReplyMessage } from "./reply.js";
import { mdToPlainText, mdToTgHtml } from "./format.js";
import { REPLY_BY_KIND, prepareCronReply } from "./delivery.js";
import { stripProtocolTags, splitMessage } from "./streaming.js";
import {
	chatKey,
	truncate,
	extractCommandArgs,
	splitCommandArgs,
	parseNamedPrompt,
	parseDurationMs,
	looksLikeTimezone,
	formatDateTime,
	formatCronSchedule,
	formatCronJobLine,
	formatCronStatus,
	describeTelegramSendError,
	isMessageNotModifiedError,
} from "./utils.js";

const CRON_MENU_PAGE_SIZE = 6;

const CRON_HELP_TEXT = [
	"⏰ /cron usage",
	"- /cron (open interactive menu)",
	"- /cron list",
	"- /cron stat",
	"- /cron add at <ISO-time> <content> (use name||content to set job name)",
	"- /cron add every <interval> <content> (e.g. 10m, 2h, 1d; use name||content)",
	'- /cron add cron "<expression>" [timezone] <content> (use name||content)',
	"- /cron on <id>",
	"- /cron off <id>",
	"- /cron del <id>",
	"- /cron rename <id> <new name>",
	"- /cron run <id>",
].join("\n");

// --- cron reply sending (uses bot.api, not tgCtx.reply) ---

async function sendCronAttachment(
	shared: SharedBotState,
	chatId: number,
	att: TgAttachment,
): Promise<void> {
	const api = shared.bot.api;
	const kind = REPLY_BY_KIND[att.kind] || "replyWithDocument";

	const senders: Record<string, (cid: number, media: any) => Promise<unknown>> =
		{
			replyWithPhoto: (cid, m) => api.sendPhoto(cid, m),
			replyWithDocument: (cid, m) => api.sendDocument(cid, m),
			replyWithVideo: (cid, m) => api.sendVideo(cid, m),
			replyWithAudio: (cid, m) => api.sendAudio(cid, m),
			replyWithAnimation: (cid, m) => api.sendAnimation(cid, m),
			replyWithVoice: (cid, m) => api.sendVoice(cid, m),
			replyWithVideoNote: (cid, m) => api.sendVideoNote(cid, m),
			replyWithSticker: (cid, m) => api.sendSticker(cid, m),
		};

	const sender = senders[kind] || senders.replyWithDocument;
	try {
		await sender(chatId, att.media);
	} catch (err) {
		if (kind === "replyWithDocument") throw err;
		await senders.replyWithDocument(chatId, att.media);
	}
}

async function getCronReplyScope(
	shared: SharedBotState,
	chatId: number,
): Promise<string> {
	if (shared.cronScopeBotId == null) {
		const me = await shared.bot.api.getMe();
		shared.cronScopeBotId = me.id;
	}
	return `${shared.cronScopeBotId}:${chatId}`;
}

async function sendCronReply(
	shared: SharedBotState,
	chatId: number,
	text: string,
	tools: string[],
): Promise<void> {
	const prepared = prepareCronReply(text, tools);
	const scope = await getCronReplyScope(shared, chatId);

	if (prepared.warnings.length) {
		const preview = prepared.warnings.slice(0, 3).join("\n");
		const more =
			prepared.warnings.length > 3
				? `\n... and ${prepared.warnings.length - 3} items in queue`
				: "";
		await shared.bot.api
			.sendMessage(chatId, `⚠️ Attachment parse warnings: \n${preview}${more}`)
			.catch(() => {});
	}

	if (prepared.body.trim()) {
		for (const part of splitMessage(prepared.body, shared.maxResponseLength)) {
			const html = mdToTgHtml(part);
			try {
				const sent = await shared.bot.api.sendMessage(chatId, html, {
					parse_mode: "HTML",
				});
				rememberReplyMessage(scope, "self", sent.message_id, part);
			} catch (err) {
				log.warn(
					`chat${chatId} Cron task HTML send failed, falling back to plain text: ${describeTelegramSendError(err)}`,
				);
				const plain = mdToPlainText(stripProtocolTags(part));
				const sent = await shared.bot.api.sendMessage(chatId, plain);
				rememberReplyMessage(scope, "self", sent.message_id, plain);
			}
		}
	}

	for (const att of prepared.attachments) {
		try {
			await sendCronAttachment(shared, chatId, att);
		} catch (err) {
			await shared.bot.api
				.sendMessage(
					chatId,
					`❌ Attachment send failed: ${att.label || "Unknown attachment"}\n${(err as Error).message}`,
				)
				.catch(() => {});
		}
	}
}

// --- cron executor (wired into CronService) ---

export function setupCronExecutor(shared: SharedBotState): void {
	const { botKey, pool, cron } = shared;

	cron.setExecutor(async ({ job }) => {
		const key = chatKey(botKey, job.chatId);
		const inst = pool.get(key);
		try {
			const result = await inst.prompt(job.prompt);
			await sendCronReply(shared, job.chatId, result.text, result.tools);
			return { ok: true };
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			await shared.bot.api
				.sendMessage(
					job.chatId,
					`❌ Cron task "${job.name || job.id}" execution failed: ${truncate(message, 1500)}`,
				)
				.catch(() => {});
			return { ok: false, error: message };
		}
	});
}

// --- cron directive execution (from AI output) ---

export async function executeCronDirectiveForChat(
	shared: SharedBotState,
	chatId: number,
	directive: TgCronDirective,
): Promise<{ notices: string[]; warnings: string[] }> {
	const { cron } = shared;
	const notices: string[] = [];
	const warnings: string[] = [];

	const ensureOwned = (id: string): CronJobRecord => {
		const job = cron.get(id);
		if (!job || job.chatId !== chatId)
			throw new Error("Job not found (or not in this chat)");
		return job;
	};

	switch (directive.action) {
		case "list": {
			const jobs = cron.list(chatId);
			notices.push(
				!jobs.length
					? "⏰ No cron tasks in this chat."
					: `⏰ Cron tasks (${jobs.length})\n${jobs.map((x) => formatCronJobLine(x)).join("\n")}`,
			);
			break;
		}
		case "stat": {
			notices.push(formatCronStatus(cron.status(chatId)));
			break;
		}
		case "add": {
			const prompt = String(directive.prompt || "").trim();
			if (!prompt) throw new Error("add missing task content");
			const kind = directive.kind;
			if (!kind) throw new Error("add missing kind");
			let schedule: CronSchedule;
			if (kind === "at") {
				const atMs = new Date(String(directive.at || "").trim()).getTime();
				if (!Number.isFinite(atMs))
					throw new Error("add kind=at: invalid at time (ISO time required)");
				schedule = { kind: "at", atMs };
			} else if (kind === "every") {
				const everyMs = parseDurationMs(String(directive.every || "").trim());
				if (!everyMs)
					throw new Error(
						"add kind=every: invalid every value (e.g. 10m/2h/1d)",
					);
				schedule = { kind: "every", everyMs, anchorMs: Date.now() };
			} else {
				const expr = String(directive.expr || "").trim();
				if (!expr) throw new Error("add kind=cron missing expr");
				const tzRaw = String(directive.timezone || "").trim();
				const timezone = tzRaw || cron.getDefaultTimezone();
				if (!looksLikeTimezone(timezone))
					throw new Error(`Invalid timezone: ${timezone}`);
				schedule = { kind: "cron", expr, timezone };
			}
			const created = await cron.create({
				chatId,
				name: directive.name,
				prompt,
				schedule,
			});
			notices.push(
				`✅ Task created ${created.id}\n${formatCronSchedule(created.schedule)}\nName: ${created.name}`,
			);
			break;
		}
		case "on": {
			const id = String(directive.id || "").trim();
			if (!id) throw new Error("on missing id");
			ensureOwned(id);
			await cron.setEnabled(id, true);
			notices.push(`✅ Task ${id} enabled`);
			break;
		}
		case "off": {
			const id = String(directive.id || "").trim();
			if (!id) throw new Error("off missing id");
			ensureOwned(id);
			await cron.setEnabled(id, false);
			notices.push(`✅ Task ${id} disabled`);
			break;
		}
		case "del": {
			const id = String(directive.id || "").trim();
			if (!id) throw new Error("del missing id");
			ensureOwned(id);
			await cron.remove(id);
			notices.push(`🗑 Deleted task ${id}`);
			break;
		}
		case "rename": {
			const id = String(directive.id || "").trim();
			if (!id) throw new Error("rename missing id");
			ensureOwned(id);
			const newName = String(directive.name || "").trim();
			if (!newName) throw new Error("rename missing name");
			const updated = await cron.rename(id, newName);
			if (!updated) throw new Error("Rename failed");
			notices.push(`✏️ Task ${id} renamed to: ${updated.name}`);
			break;
		}
		case "run": {
			const id = String(directive.id || "").trim();
			if (!id) throw new Error("run missing id");
			ensureOwned(id);
			const ok = await cron.runNow(id);
			notices.push(
				ok
					? `▶️ Task ${id} added to queue`
					: `❌ Task ${id} failed to add to queue`,
			);
			break;
		}
		default:
			warnings.push(`Unsupported tg-cron action: ${(directive as any).action}`);
			break;
	}

	return { notices, warnings };
}

export async function applyCronToolDirectives(
	shared: SharedBotState,
	tgCtx: BotContext,
	text: string,
): Promise<{ text: string; warnings: string[] }> {
	const extracted = extractTgCronDirectives(text || "");
	const warnings = [...extracted.warnings];
	const notices: string[] = [];
	const chatId = tgCtx.chat?.id ?? 0;

	for (const directive of extracted.directives) {
		try {
			const res = await executeCronDirectiveForChat(shared, chatId, directive);
			notices.push(...res.notices);
			warnings.push(...res.warnings);
		} catch (err) {
			warnings.push(
				`tg-cron(${directive.action}) execution failed: ${(err as Error).message}`,
			);
		}
	}

	const mergedText = [extracted.text.trim(), ...notices]
		.filter(Boolean)
		.join("\n\n");
	return { text: mergedText, warnings };
}

// --- pending cron input consumption ---

export async function consumePendingCronInput(
	shared: SharedBotState,
	tgCtx: BotContext,
	pending: CronPendingInput,
	text: string,
	cronMenu: Menu<BotContext>,
): Promise<boolean> {
	const { cron } = shared;
	const chatId = tgCtx.chat?.id ?? 0;
	const raw = String(text || "").trim();
	if (!raw) return true;

	const upsert = async () => {
		shared.cronPendingInput.delete(chatId);
		const menuTitle = buildCronMenuTitle(shared, chatId);
		const existingId = shared.cronMenuMessageByChat.get(chatId);
		if (existingId) {
			try {
				await tgCtx.api.editMessageText(chatId, existingId, menuTitle, {
					reply_markup: cronMenu,
				});
				return;
			} catch (err) {
				if (isMessageNotModifiedError(err)) return;
				shared.cronMenuMessageByChat.delete(chatId);
			}
		}
		const sent = await tgCtx.reply(menuTitle, { reply_markup: cronMenu });
		shared.cronMenuMessageByChat.set(chatId, sent.message_id);
	};

	try {
		if (pending.kind === "rename") {
			const job = cron.get(pending.jobId);
			if (!job || job.chatId !== chatId) {
				shared.cronPendingInput.delete(chatId);
				await tgCtx.reply("❌ Target task not found or not in this chat");
				return true;
			}
			const updated = await cron.rename(pending.jobId, raw);
			await upsert();
			await tgCtx.reply(
				!updated
					? "❌ Rename failed"
					: `✏️ Task ${updated.id} renamed to: ${updated.name}`,
			);
			return true;
		}

		if (pending.kind === "at") {
			const firstSpace = raw.indexOf(" ");
			if (firstSpace < 0) {
				await tgCtx.reply("❌ Invalid format, send: <ISO time> <content>");
				return true;
			}
			const atRaw = raw.slice(0, firstSpace).trim();
			const named = parseNamedPrompt(raw.slice(firstSpace + 1));
			const atMs = new Date(atRaw).getTime();
			if (!Number.isFinite(atMs) || !named.prompt) {
				await tgCtx.reply("❌ Invalid format, send: <ISO time> <content>");
				return true;
			}
			const job = await cron.create({
				chatId,
				name: named.name,
				prompt: named.prompt,
				schedule: { kind: "at", atMs },
			});
			await upsert();
			await tgCtx.reply(
				`✅ Task created ${job.id}\n${formatCronSchedule(job.schedule)}\nName: ${job.name}`,
			);
			return true;
		}

		if (pending.kind === "every") {
			const firstSpace = raw.indexOf(" ");
			if (firstSpace < 0) {
				await tgCtx.reply(
					"❌ Invalid format. Usage: <interval> <content>, Example: 10m Check alerts",
				);
				return true;
			}
			const everyRaw = raw.slice(0, firstSpace).trim();
			const named = parseNamedPrompt(raw.slice(firstSpace + 1));
			const everyMs = parseDurationMs(everyRaw);
			if (!everyMs || !named.prompt) {
				await tgCtx.reply(
					"❌ Invalid interval format. Supported: s/m/h/d (e.g. 30s, 10m, 2h, 1d)",
				);
				return true;
			}
			const job = await cron.create({
				chatId,
				name: named.name,
				prompt: named.prompt,
				schedule: { kind: "every", everyMs, anchorMs: Date.now() },
			});
			await upsert();
			await tgCtx.reply(
				`✅ Task created ${job.id}\n${formatCronSchedule(job.schedule)}\nName: ${job.name}`,
			);
			return true;
		}

		// pending.kind === "cron"
		const parts = raw
			.split("|")
			.map((x) => x.trim())
			.filter(Boolean);
		if (parts.length < 2) {
			await tgCtx.reply(
				"❌ Invalid format. Usage: <expression> | [timezone] | [name] | <content>",
			);
			return true;
		}
		const expr = parts[0];
		let timezone = cron.getDefaultTimezone();
		let name: string | undefined;
		let prompt = "";
		if (parts.length >= 4) {
			timezone = parts[1];
			name = parts[2] || undefined;
			prompt = parts.slice(3).join(" | ").trim();
		} else if (parts.length === 3) {
			timezone = parts[1];
			const named = parseNamedPrompt(parts[2]);
			name = named.name;
			prompt = named.prompt;
		} else {
			const named = parseNamedPrompt(parts[1]);
			name = named.name;
			prompt = named.prompt;
		}
		if (!prompt) {
			await tgCtx.reply(
				"❌ Missing task content. Usage: <expression> | [timezone] | [name] | <content>",
			);
			return true;
		}
		if (!looksLikeTimezone(timezone)) {
			await tgCtx.reply(`❌ Invalid timezone format: ${timezone}`);
			return true;
		}
		const job = await cron.create({
			chatId,
			name,
			prompt,
			schedule: { kind: "cron", expr, timezone },
		});
		await upsert();
		await tgCtx.reply(
			`✅ Task created ${job.id}\n${formatCronSchedule(job.schedule)}\nName: ${job.name}`,
		);
		return true;
	} catch (err) {
		await tgCtx
			.reply(
				`❌ Task creation failed: ${truncate((err as Error).message, 800)}\nYou can continue typing, or cancel in /cron menu`,
			)
			.catch(() => {});
		return true;
	}
}

// --- cron menu title ---

function buildCronMenuTitle(shared: SharedBotState, chatId: number): string {
	const pending = shared.cronPendingInput.get(chatId);
	const hint = pending
		? `\nAwaiting input: ${pending.kind} (send text directly, or cancel in menu)`
		: "";
	return `⏰ Cron task menu${hint}`;
}

function setCronMenuPage(
	shared: SharedBotState,
	chatId: number,
	page: number,
	totalPages: number,
): number {
	const safeTotal = Math.max(1, totalPages);
	const next = Math.max(0, Math.min(page, safeTotal - 1));
	shared.cronMenuPageByChat.set(chatId, next);
	return next;
}

// --- cron Grammy menu + /cron command ---

export function createCronMenu(shared: SharedBotState): Menu<BotContext> {
	const { cron, botIndex } = shared;
	const cronRootMenuId = `cron-menu-${botIndex}`;

	const cronMenu = new Menu<BotContext>(cronRootMenuId, {
		onMenuOutdated: "Menu updated, please retry",
		fingerprint: (ctx) => {
			const chatId = ctx.chat?.id ?? 0;
			const st = cron.status(chatId);
			const pending = shared.cronPendingInput.get(chatId);
			const page = shared.cronMenuPageByChat.get(chatId) ?? 0;
			const jobs = cron
				.list(chatId)
				.slice(0, 60)
				.map(
					(x) =>
						`${x.id}:${x.enabled ? 1 : 0}:${x.updatedAtMs}:${x.state.runningRunId ? 1 : 0}`,
				)
				.join(",");
			return [
				`enabled:${st.enabled ? 1 : 0}`,
				`total:${st.totalJobs}`,
				`queued:${st.queuedJobs}`,
				`running:${st.runningJobs}`,
				`pending:${pending?.kind ?? ""}`,
				`page:${page}`,
				jobs,
			].join("|");
		},
	}).dynamic((ctx, range) => {
		const chatId = ctx.chat?.id ?? 0;
		const menuMessageId = Number((ctx.msg as any)?.message_id);
		if (Number.isSafeInteger(menuMessageId) && menuMessageId > 0) {
			shared.cronMenuMessageByChat.set(chatId, menuMessageId);
		}
		const st = cron.status(chatId);
		const jobs = cron.list(chatId);
		const pending = shared.cronPendingInput.get(chatId);
		const totalPages = Math.max(
			1,
			Math.ceil(jobs.length / CRON_MENU_PAGE_SIZE),
		);
		const rawPage = shared.cronMenuPageByChat.get(chatId) ?? 0;
		const page = setCronMenuPage(shared, chatId, rawPage, totalPages);
		const start = page * CRON_MENU_PAGE_SIZE;
		const pageJobs = jobs.slice(start, start + CRON_MENU_PAGE_SIZE);

		range
			.text(
				`📊 ${st.enabled ? "On" : "Off"} | Tasks ${st.totalJobs} | Running ${st.runningJobs} | Queued ${st.queuedJobs}`,
				(ctx) => ctx.answerCallbackQuery({ text: "Status updated" }),
			)
			.row();

		range.text("🔄 Refresh", async (ctx) => {
			try {
				ctx.menu.update();
			} catch {
				/* ignore */
			}
			await ctx.answerCallbackQuery({ text: "Refreshed" });
		});

		range
			.text("➕ One-time", async (ctx) => {
				shared.cronPendingInput.set(chatId, {
					kind: "at",
					startedAt: Date.now(),
				});
				await ctx.answerCallbackQuery({ text: "Send: <ISO time> <content>" });
				await ctx.reply(
					"🕒 Enter one-time task: \n<ISO time> <content>\nWith name: <ISO time> <name||content>\nExample: 2026-03-01T09:00:00+08:00 Morning briefing",
				);
				try {
					ctx.menu.update();
				} catch {
					/* ignore */
				}
			})
			.row();

		range.text("➕ Interval", async (ctx) => {
			shared.cronPendingInput.set(chatId, {
				kind: "every",
				startedAt: Date.now(),
			});
			await ctx.answerCallbackQuery({ text: "Send: <interval> <content>" });
			await ctx.reply(
				"⏱ Enter interval task: \n<interval> <content>\nWith name: <interval> <name||content>\nExample: 10m Check alerts\nSupported: s/m/h/d",
			);
			try {
				ctx.menu.update();
			} catch {
				/* ignore */
			}
		});

		range
			.text("➕ Cron", async (ctx) => {
				shared.cronPendingInput.set(chatId, {
					kind: "cron",
					startedAt: Date.now(),
				});
				await ctx.answerCallbackQuery({
					text: "Send: <expression> | [timezone] | [name] | <content>",
				});
				await ctx.reply(
					"🧩 Enter Cron task: \n<expression> | [timezone] | [name] | <content>\nExample: 0 9 * * 1-5 | Asia/Shanghai | Weekday briefing | Daily summary",
				);
				try {
					ctx.menu.update();
				} catch {
					/* ignore */
				}
			})
			.row();

		if (pending) {
			const ageSec = Math.max(
				0,
				Math.floor((Date.now() - pending.startedAt) / 1000),
			);
			range
				.text(`❌ Cancel input (${pending.kind}, ${ageSec}s)`, async (ctx) => {
					shared.cronPendingInput.delete(chatId);
					try {
						ctx.menu.update();
					} catch {
						/* ignore */
					}
					await ctx.answerCallbackQuery({ text: "Cancelled" });
				})
				.row();
		}

		if (!jobs.length) {
			range.text("No tasks", (ctx) =>
				ctx.answerCallbackQuery({ text: "No tasks yet" }),
			);
			return;
		}

		range
			.text(`📄 Page ${page + 1}/${totalPages}`, (ctx) =>
				ctx.answerCallbackQuery({ text: `${pageJobs.length} items in queue` }),
			)
			.row();

		for (const job of pageJobs) {
			const icon = job.enabled ? "🟢" : "⚪";
			const running = job.state.runningRunId ? " ⏳" : "";
			range
				.text(
					`${icon}${running} ${truncate(job.name, 18)} [${job.id}]`,
					(ctx) =>
						ctx.answerCallbackQuery({
							text: `${formatCronSchedule(job.schedule)} | next=${formatDateTime(job.state.nextRunAtMs)}`.slice(
								0,
								190,
							),
						}),
				)
				.row();

			range.text(job.enabled ? "⏸ Disable" : "▶️ Enable", async (ctx) => {
				await cron.setEnabled(job.id, !job.enabled);
				try {
					ctx.menu.update();
				} catch {
					/* ignore */
				}
				await ctx.answerCallbackQuery({
					text: job.enabled ? "Disabled" : "Enabled",
				});
			});
			range.text("▶️ Run", async (ctx) => {
				const ok = await cron.runNow(job.id);
				try {
					ctx.menu.update();
				} catch {
					/* ignore */
				}
				await ctx.answerCallbackQuery({
					text: ok ? "Added to execution queue" : "Failed to add",
				});
			});
			range
				.text("✏️ Rename", async (ctx) => {
					shared.cronPendingInput.set(chatId, {
						kind: "rename",
						jobId: job.id,
						startedAt: Date.now(),
					});
					try {
						ctx.menu.update();
					} catch {
						/* ignore */
					}
					await ctx.answerCallbackQuery({ text: "Send new name" });
					await ctx.reply(`✏️ Send new name for task ${job.id}`);
				})
				.row();
			range
				.text("🗑 Delete", async (ctx) => {
					await cron.remove(job.id);
					const nextTotalPages = Math.max(
						1,
						Math.ceil(Math.max(0, jobs.length - 1) / CRON_MENU_PAGE_SIZE),
					);
					setCronMenuPage(shared, chatId, page, nextTotalPages);
					try {
						ctx.menu.update();
					} catch {
						/* ignore */
					}
					await ctx.answerCallbackQuery({ text: "Deleted" });
				})
				.row();
		}

		if (totalPages > 1) {
			range.text("⬅️ Prev", async (ctx) => {
				setCronMenuPage(shared, chatId, page - 1, totalPages);
				try {
					ctx.menu.update();
				} catch {
					/* ignore */
				}
				await ctx.answerCallbackQuery({ text: `Page ${Math.max(1, page)}` });
			});
			range
				.text("➡️ Next", async (ctx) => {
					setCronMenuPage(shared, chatId, page + 1, totalPages);
					try {
						ctx.menu.update();
					} catch {
						/* ignore */
					}
					await ctx.answerCallbackQuery({
						text: `Page ${Math.min(totalPages, page + 2)}`,
					});
				})
				.row();
		}
	});

	return cronMenu;
}

// --- /cron command handler ---

export function registerCronCommand(
	shared: SharedBotState,
	commandGroup: import("@grammyjs/commands").CommandGroup<BotContext>,
	cronMenu: Menu<BotContext>,
): void {
	const { cron } = shared;

	const upsertCronMenuMessage = async (tgCtx: BotContext): Promise<void> => {
		const chatId = tgCtx.chat?.id ?? 0;
		const text = buildCronMenuTitle(shared, chatId);
		const existingId = shared.cronMenuMessageByChat.get(chatId);
		await cronMenu.middleware()(tgCtx, async () => {});
		if (existingId) {
			try {
				await tgCtx.api.editMessageText(chatId, existingId, text, {
					reply_markup: cronMenu,
				});
				return;
			} catch (err) {
				if (isMessageNotModifiedError(err)) return;
				shared.cronMenuMessageByChat.delete(chatId);
				log.warn(
					`chat${chatId} Failed to update /cron menu, will try resending: ${describeTelegramSendError(err)}`,
				);
			}
		}
		const sent = await tgCtx.reply(text, { reply_markup: cronMenu });
		shared.cronMenuMessageByChat.set(chatId, sent.message_id);
	};

	commandGroup.command("cron", "Manage cron tasks", async (tgCtx) => {
		try {
			const raw = extractCommandArgs(
				String((tgCtx.message as any)?.text || ""),
				"cron",
			);
			const chatId = tgCtx.chat.id;

			if (!raw.trim()) {
				await upsertCronMenuMessage(tgCtx);
				return;
			}

			const args = splitCommandArgs(raw);
			const sub = (args.shift() || "help").toLowerCase();

			if (sub === "help" || sub === "h" || sub === "?") {
				await tgCtx.reply(CRON_HELP_TEXT);
				return;
			}

			if (sub === "list" || sub === "ls") {
				const jobs = cron.list(chatId);
				if (!jobs.length) {
					await tgCtx.reply(
						"No cron tasks in this chat. Use /cron add ... to create one.",
					);
					return;
				}
				const text = `⏰ Cron tasks (${jobs.length})\n${jobs.map((job) => formatCronJobLine(job)).join("\n")}`;
				for (const part of splitMessage(text, shared.maxResponseLength))
					await tgCtx.reply(part);
				return;
			}

			if (sub === "stat" || sub === "status") {
				await tgCtx.reply(formatCronStatus(cron.status(chatId)));
				return;
			}

			if (sub === "add") {
				const kind = (args.shift() || "").toLowerCase();
				if (!kind) {
					await tgCtx.reply("Usage: /cron add at|every|cron ...");
					return;
				}

				if (kind === "at") {
					const atRaw = args.shift() || "";
					const named = parseNamedPrompt(args.join(" "));
					if (!atRaw || !named.prompt) {
						await tgCtx.reply("Usage: /cron add at <ISO time> <content>");
						return;
					}
					const atMs = new Date(atRaw).getTime();
					if (!Number.isFinite(atMs)) {
						await tgCtx.reply(
							"Invalid time format, use ISO 8601, e.g. 2026-03-01T09:00:00+08:00",
						);
						return;
					}
					const job = await cron.create({
						chatId,
						name: named.name,
						prompt: named.prompt,
						schedule: { kind: "at", atMs },
					});
					await tgCtx.reply(
						`✅ Task created ${job.id}\n${formatCronSchedule(job.schedule)}\nName: ${job.name}`,
					);
					return;
				}

				if (kind === "every") {
					const everyRaw = args.shift() || "";
					const named = parseNamedPrompt(args.join(" "));
					const everyMs = parseDurationMs(everyRaw);
					if (!everyMs || !named.prompt) {
						await tgCtx.reply(
							"Usage: /cron add every <interval> <content>\nExample: /cron add every 10m Morning briefing",
						);
						return;
					}
					const job = await cron.create({
						chatId,
						name: named.name,
						prompt: named.prompt,
						schedule: { kind: "every", everyMs, anchorMs: Date.now() },
					});
					await tgCtx.reply(
						`✅ Task created ${job.id}\n${formatCronSchedule(job.schedule)}\nName: ${job.name}`,
					);
					return;
				}

				if (kind === "cron") {
					const expr = args.shift() || "";
					if (!expr) {
						await tgCtx.reply(
							'Usage: /cron add cron "<expression>" [timezone] <content>',
						);
						return;
					}
					let timezone = cron.getDefaultTimezone();
					if (args.length >= 2 && looksLikeTimezone(args[0]))
						timezone = args.shift()!;
					const named = parseNamedPrompt(args.join(" "));
					if (!named.prompt) {
						await tgCtx.reply(
							'Usage: /cron add cron "<expression>" [timezone] <content>',
						);
						return;
					}
					const job = await cron.create({
						chatId,
						name: named.name,
						prompt: named.prompt,
						schedule: { kind: "cron", expr, timezone },
					});
					await tgCtx.reply(
						`✅ Task created ${job.id}\n${formatCronSchedule(job.schedule)}\nName: ${job.name}`,
					);
					return;
				}
				await tgCtx.reply("Unsupported type, only at / every / cron");
				return;
			}

			if (sub === "on" || sub === "off") {
				const id = (args.shift() || "").trim();
				if (!id) {
					await tgCtx.reply("Usage: /cron on <id> or /cron off <id>");
					return;
				}
				const updated = await cron.setEnabled(id, sub === "on");
				if (!updated || updated.chatId !== chatId) {
					await tgCtx.reply("Job not found (or not in this chat)");
					return;
				}
				await tgCtx.reply(
					`✅ Task ${id} ${sub === "on" ? "enabled" : "disabled"}`,
				);
				return;
			}

			if (sub === "del" || sub === "rm" || sub === "remove") {
				const id = (args.shift() || "").trim();
				if (!id) {
					await tgCtx.reply("Usage: /cron del <id>");
					return;
				}
				const job = cron.get(id);
				if (!job || job.chatId !== chatId) {
					await tgCtx.reply("Job not found (or not in this chat)");
					return;
				}
				await cron.remove(id);
				await tgCtx.reply(`🗑 Deleted task ${id}`);
				return;
			}

			if (sub === "rename" || sub === "name") {
				const id = (args.shift() || "").trim();
				const newName = args.join(" ").trim();
				if (!id || !newName) {
					await tgCtx.reply("Usage: /cron rename <id> <new name>");
					return;
				}
				const job = cron.get(id);
				if (!job || job.chatId !== chatId) {
					await tgCtx.reply("Job not found (or not in this chat)");
					return;
				}
				const updated = await cron.rename(id, newName);
				if (!updated) {
					await tgCtx.reply("Rename failed");
					return;
				}
				await tgCtx.reply(`✏️ Task ${id} renamed to: ${updated.name}`);
				return;
			}

			if (sub === "run") {
				const id = (args.shift() || "").trim();
				if (!id) {
					await tgCtx.reply("Usage: /cron run <id>");
					return;
				}
				const job = cron.get(id);
				if (!job || job.chatId !== chatId) {
					await tgCtx.reply("Job not found (or not in this chat)");
					return;
				}
				const ok = await cron.runNow(id);
				await tgCtx.reply(
					ok ? `▶️ Task ${id} added to queue` : "Failed to add to queue",
				);
				return;
			}

			await tgCtx.reply("Unknown subcommand. Send /cron help for usage.");
		} catch (err) {
			await tgCtx
				.reply(
					`❌ Cron operation failed: ${truncate((err as Error).message, 1000)}`,
				)
				.catch(() => {});
		}
	});
}
