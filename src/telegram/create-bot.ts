// src/telegram/create-bot.ts — thin orchestrator that wires modules together
import { createHash } from "node:crypto";
import { Bot, GrammyError, HttpError } from "grammy";
import { autoRetry } from "@grammyjs/auto-retry";
import { hydrate } from "@grammyjs/hydrate";
import { hydrateFiles } from "@grammyjs/files";
import { autoChatAction } from "@grammyjs/auto-chat-action";
import { log } from "../shared/log.js";
import { createBotMenus } from "./menu.js";
import { rememberReplyMessage } from "./reply.js";
import type {
	CreateBotOptions,
	SharedBotState,
	BotContext,
	PromptPayload,
	PromptBuildOptions,
} from "./bot-context.js";
import {
	chatKey,
	replyScopeKey,
	truncate,
	getMessageThreadId,
	shouldUseDraftStreaming,
	extractMessageText,
	formatMessageSender,
	normalizePromptPath,
	normalizePromptPathList,
	maybeWarnContextFull,
	reportStatusOrReply,
	describeTelegramSendError,
} from "./utils.js";
import {
	downloadImageByFileId,
	downloadInboundFileByFileId,
	collectReferencedImages,
	dedupeLoadedImageGroups,
	toPromptPathList,
	supportsImagesForChat,
} from "./images.js";
import {
	stripProtocolTags,
	createDraftStreamUpdater,
	createSilentStreamUpdater,
} from "./streaming.js";
import { sendReply, sendPreparedReply } from "./delivery.js";
import {
	registerCommands,
	createActivePromptTracker,
	consumeAbortNoticeSuppression,
} from "./commands.js";
import {
	createCronMenu,
	setupCronExecutor,
	registerCronCommand,
	applyCronToolDirectives,
	registerCronApprovalHandlers,
	consumePendingCronInput,
} from "./cron-ui.js";

export type { CreateBotOptions } from "./bot-context.js";
export {
	stripProtocolTags,
	buildStreamingPreview,
	createDraftPreviewModel,
} from "./streaming.js";
export type { DraftPreviewModel } from "./bot-context.js";

export function createBot(opts: CreateBotOptions): Bot<BotContext> {
	const {
		botIndex,
		config,
		pool,
		cron,
		maxResponseLength,
		initialStreamByChat,
		onStreamModeChange,
	} = opts;

	const bot = new Bot<BotContext>(config.token);
	const botKey = createHash("sha1")
		.update(config.token)
		.digest("hex")
		.slice(0, 12);

	// --- plugins ---
	bot.api.config.use(hydrateFiles(config.token));
	bot.api.config.use(autoRetry({ maxRetryAttempts: 5, maxDelaySeconds: 60 }));
	bot.use(hydrate());
	bot.use(autoChatAction());

	// --- auth guard (fail closed) ---
	// Always installed. An empty allowlist means nobody is allowed, never everybody.
	const allowed = new Set(
		(config.allowedUsers ?? []).filter((id): id is number => typeof id === "number" && Number.isSafeInteger(id)),
	);
	bot.use(async (tgCtx, next) => {
		const uid = tgCtx.from?.id;
		if (uid !== undefined && allowed.has(uid)) return next();
		if (tgCtx.chat?.type === "private") {
			await tgCtx.reply("⛔ Unauthorized");
		}
	});

	// --- error handler ---
	bot.catch((err) => {
		const e = err.error;
		if (e instanceof GrammyError) {
			if (e.description.includes("query is too old")) return;
			if (e.description.includes("message is not modified")) return;
			log.error(`bot${botIndex}`, `TG API: ${e.description}`);
		} else if (e instanceof HttpError) {
			log.error(`bot${botIndex}`, `HTTP: ${e}`);
		} else {
			log.error(`bot${botIndex}`, `${e}`);
		}
	});

	// --- menus ---
	const menus = createBotMenus<BotContext>({
		botIndex,
		botKey,
		pool,
		outdatedMenuText: "Menu updated, please retry",
		initialStreamByChat,
		onStreamModeChange,
	});
	const { modelMenu, streamMenu, thinkingMenu } = menus;
	bot.use(modelMenu);
	bot.use(streamMenu);
	bot.use(thinkingMenu);

	// --- shared state ---
	const shared: SharedBotState = {
		botIndex,
		botKey,
		config,
		pool,
		cron,
		maxResponseLength,
		bot,
		menus,
		onStreamModeChange,
		activePromptByChat: new Map(),
		abortDirectiveByPromptToken: new Map(),
		abortNoticeSuppressionByChat: new Map(),
		pendingForkMessages: new Map(),
		cronPendingInput: new Map(),
		cronMenuPageByChat: new Map(),
		cronMenuMessageByChat: new Map(),
		imageSupportCache: new Map(),
		draftCounterByChat: new Map(),
		cronScopeBotId: null,
	};

	// --- commands ---
	const commandGroup = registerCommands(shared);
	bot.use(commandGroup);

	// --- cron ---
	setupCronExecutor(shared);
	const cronMenu = createCronMenu(shared);
	bot.use(cronMenu);
	registerCronCommand(shared, commandGroup, cronMenu);
	registerCronApprovalHandlers(bot as any, shared);

	// --- prompt execution ---
	function nextDraftId(chatId: number): number {
		const prev = shared.draftCounterByChat.get(chatId) ?? 0;
		const next = prev >= 2_000_000_000 ? 1 : prev + 1;
		shared.draftCounterByChat.set(chatId, next);
		return next;
	}

	async function runPromptRequest(
		tgCtx: BotContext,
		inst: ReturnType<typeof pool.get>,
		makePayload: (opts: PromptBuildOptions) => Promise<PromptPayload>,
	): Promise<void> {
		const ahead = inst.queuedCount + (inst.running ? 1 : 0);
		const chatId = tgCtx.chat?.id ?? 0;
		const useStream = menus.isStreamEnabled(chatId);
		const useDraftStream = useStream && shouldUseDraftStreaming(tgCtx);

		const initialStatus =
			ahead > 0 ? `⏳ Queued (${ahead} items in queue)...` : "⏳ Thinking...";
		const status = !useStream ? await tgCtx.reply(initialStatus) : null;

		let streamedText = "";
		tgCtx.chatAction = "typing";

		const promptTracker = createActivePromptTracker(
			shared,
			chatId,
			useStream ? "stream" : "non-stream",
		);
		const onStart = () => {
			promptTracker.onStart();
			if (!status || ahead <= 0) return;
			void status.editText("⏳ Thinking...").catch(() => {});
		};

		try {
			const supportsImages = await supportsImagesForChat(
				chatId,
				inst,
				shared.imageSupportCache,
			);
			const { message, images } = await makePayload({ supportsImages });

			if (useStream) {
				const stream = useDraftStream
					? createDraftStreamUpdater(
							tgCtx.api,
							chatId,
							nextDraftId(chatId),
							getMessageThreadId(tgCtx),
							maxResponseLength,
							(err) =>
								log.warn(
									`chat${chatId} sendMessageDraft preview failed, skipping: ${describeTelegramSendError(err)}`,
								),
						)
					: createSilentStreamUpdater();

				try {
					const result = await inst.prompt(message, images, {
						onStart,
						onTextDelta: (delta, fullText) => {
							streamedText = stripProtocolTags(fullText);
							stream.onTextDelta(delta, fullText);
						},
						onToolStart: stream.onToolStart,
						onToolError: stream.onToolError,
					});
					await stream.stopAndWait();
					const processed = await applyCronToolDirectives(
						shared,
						tgCtx,
						result.text,
					);
					await sendReply(
						tgCtx,
						processed.text,
						result.tools,
						maxResponseLength,
						processed.warnings,
					);
					await maybeWarnContextFull(tgCtx, inst);
				} finally {
					await stream.stopAndWait();
				}
				return;
			}

			const result = await inst.prompt(message, images, {
				onStart,
				onTextDelta: (_delta, fullText) => {
					streamedText = stripProtocolTags(fullText);
				},
			});
			await status?.delete().catch(() => {});
			const processed = await applyCronToolDirectives(
				shared,
				tgCtx,
				result.text,
			);
			await sendReply(
				tgCtx,
				processed.text,
				result.tools,
				maxResponseLength,
				processed.warnings,
			);
			await maybeWarnContextFull(tgCtx, inst);
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			if (message === "aborted") {
				const abortDirective = shared.abortDirectiveByPromptToken.get(
					promptTracker.token,
				);
				if (abortDirective) {
					shared.abortDirectiveByPromptToken.delete(promptTracker.token);
					await status?.delete().catch(() => {});
					const partial = stripProtocolTags(streamedText).trim();
					if (abortDirective.sendPartial && partial) {
						await sendPreparedReply(
							tgCtx,
							{ body: partial, attachments: [], warnings: [] },
							maxResponseLength,
						).catch(() => {});
					}
					if (abortDirective.showAbortNotice)
						await tgCtx.reply("💀 Killed").catch(() => {});
				} else if (consumeAbortNoticeSuppression(shared, chatId)) {
					await status?.delete().catch(() => {});
				} else if (status) {
					await reportStatusOrReply(tgCtx, status, "💀 Killed");
				} else {
					await tgCtx.reply("💀 Killed").catch(() => {});
				}
			} else if (useStream && streamedText.trim()) {
				const errLine = `⚠️ Generation interrupted: ${truncate(message, 300)}`;
				const merged = truncate(
					`${streamedText}\n\n${errLine}`,
					maxResponseLength,
				);
				if (status) await reportStatusOrReply(tgCtx, status, merged);
				else await tgCtx.reply(merged).catch(() => {});
			} else {
				const errorText = `❌ Error: ${message}`;
				if (status) await reportStatusOrReply(tgCtx, status, errorText);
				else await tgCtx.reply(errorText).catch(() => {});
			}
		} finally {
			promptTracker.finish();
			tgCtx.chatAction = null;
		}
	}

	// --- reply context builder ---
	function rememberReferencedReply(tgCtx: BotContext): void {
		const current = tgCtx.message as any;
		const replied = current?.reply_to_message as any;
		if (!replied?.message_id) return;
		const text =
			extractMessageText(replied) || String(current?.quote?.text || "").trim();
		if (!text) return;
		const role = replied?.from?.id === tgCtx.me.id ? "self" : "user";
		rememberReplyMessage(replyScopeKey(tgCtx), role, replied.message_id, text);
	}

	async function buildPromptPayloadWithReplyContext(
		tgCtx: BotContext,
		content: string,
		token: string,
		enableImages: boolean,
		currentImages: import("./bot-context.js").LoadedImage[] = [],
		currentFilePaths: string[] = [],
	): Promise<{ message: string; images?: import("../pi/types.js").PiImage[] }> {
		const dedupeIds = new Set(currentImages.map((x) => x.fileId.toLowerCase()));
		const referencedImages = await collectReferencedImages(
			tgCtx,
			token,
			dedupeIds,
			enableImages,
		);
		const deduped = dedupeLoadedImageGroups(currentImages, referencedImages);
		const normalizedCurrentFilePaths = normalizePromptPathList([
			...currentFilePaths,
			...toPromptPathList(deduped.current),
		]);

		const message = buildUserMessageWithReplyContext(tgCtx, content, {
			currentImagePaths: toPromptPathList(deduped.current),
			referencedImagePaths: toPromptPathList(deduped.referenced),
			currentFilePaths: normalizedCurrentFilePaths,
		});

		return {
			message,
			images: enableImages
				? deduped.all.flatMap((x) => (x.image ? [x.image] : []))
				: undefined,
		};
	}

	function buildUserMessageWithReplyContext(
		tgCtx: BotContext,
		content: string,
		opts: {
			currentImagePaths?: string[];
			referencedImagePaths?: string[];
			currentFilePaths?: string[];
		} = {},
	): string {
		const current = tgCtx.message as any;
		const replied = current?.reply_to_message as any;
		const quote = String(current?.quote?.text || "").trim();
		const currentImagePaths = opts.currentImagePaths ?? [];
		const referencedImagePaths = opts.referencedImagePaths ?? [];
		const currentFilePaths = opts.currentFilePaths ?? [];

		const targetText = extractMessageText(replied);
		const targetFrom = formatMessageSender(replied, tgCtx.me.id);
		const hasUsefulReply =
			!!targetText ||
			!!quote ||
			referencedImagePaths.length > 0 ||
			currentImagePaths.length > 0 ||
			currentFilePaths.length > 0;
		if (!hasUsefulReply) return content;

		const replyBlock = [
			"[Reply context start]",
			targetFrom ? `reply_to_sender: ${targetFrom}` : "",
			targetText ? `reply_to_text: ${truncate(targetText, 1200)}` : "",
			quote ? `user_selected_quote: ${truncate(quote, 500)}` : "",
			referencedImagePaths.length > 0
				? `reply_to_image_paths:\n- ${referencedImagePaths.join("\n- ")}`
				: "",
			currentImagePaths.length > 0
				? `current_image_paths:\n- ${currentImagePaths.join("\n- ")}`
				: "",
			currentFilePaths.length > 0
				? `current_file_paths:\n- ${currentFilePaths.join("\n- ")}`
				: "",
			referencedImagePaths.length > 0 || currentImagePaths.length > 0
				? "Attachment order: current_images first (if any), then reply_to_images."
				: "",
			"[Reply context end]",
		].filter(Boolean);

		return [...replyBlock, "", "[User's actual request]", content].join("\n");
	}

	// --- message handlers ---
	bot.on("message:text", async (tgCtx) => {
		const text = tgCtx.message.text;
		if (!text || text.startsWith("/")) return;

		const pending = shared.cronPendingInput.get(tgCtx.chat.id);
		if (pending) {
			const handled = await consumePendingCronInput(
				shared,
				tgCtx,
				pending,
				text,
				cronMenu,
			);
			if (handled) return;
		}

		const forkMessages = shared.pendingForkMessages.get(tgCtx.chat.id);
		if (forkMessages) {
			const num = parseInt(text.trim(), 10);
			if (Number.isFinite(num) && num >= 1 && num <= forkMessages.length) {
				const selected = forkMessages[num - 1];
				shared.pendingForkMessages.delete(tgCtx.chat.id);
				const status = await tgCtx.reply(`⏳ Forking from message ${num}...`);
				try {
					const key = chatKey(botKey, tgCtx.chat.id);
					const inst = pool.get(key);
					const result = await inst.fork(selected.entryId);
					await status.delete().catch(() => {});
					if (result.cancelled) {
						await tgCtx.reply("⚠️ Fork cancelled by extension");
						return;
					}
					await tgCtx.reply(
						`✅ Forked from message ${num}\n${truncate(result.text, 100)}`,
					);
				} catch (err) {
					await status.delete().catch(() => {});
					await tgCtx.reply(
						`❌ Fork failed: ${truncate((err as Error).message, 500)}`,
					);
				}
				return;
			}
			shared.pendingForkMessages.delete(tgCtx.chat.id);
		}

		rememberReplyMessage(
			replyScopeKey(tgCtx),
			"user",
			tgCtx.message.message_id,
			text,
		);
		rememberReferencedReply(tgCtx);

		const key = chatKey(botKey, tgCtx.chat.id);
		const inst = pool.get(key);
		await runPromptRequest(tgCtx, inst, async ({ supportsImages }) =>
			buildPromptPayloadWithReplyContext(
				tgCtx,
				text,
				config.token,
				supportsImages,
			),
		);
	});

	bot.on("message:photo", async (tgCtx) => {
		const caption = tgCtx.message.caption || "Please describe this image";
		rememberReplyMessage(
			replyScopeKey(tgCtx),
			"user",
			tgCtx.message.message_id,
			caption,
		);
		rememberReferencedReply(tgCtx);

		const key = chatKey(botKey, tgCtx.chat.id);
		const inst = pool.get(key);
		await runPromptRequest(tgCtx, inst, async ({ supportsImages }) => {
			const photos = tgCtx.message.photo;
			const current = photos[photos.length - 1];
			const image = await downloadImageByFileId(
				tgCtx,
				config.token,
				current.file_id,
				"image/jpeg",
				supportsImages,
			);
			return buildPromptPayloadWithReplyContext(
				tgCtx,
				caption,
				config.token,
				supportsImages,
				image ? [image] : [],
			);
		});
	});

	bot.on("message:document", async (tgCtx) => {
		const document = tgCtx.message.document;
		const baseText =
			tgCtx.message.caption || document.file_name || "Please process this file";
		rememberReplyMessage(
			replyScopeKey(tgCtx),
			"user",
			tgCtx.message.message_id,
			baseText,
		);
		rememberReferencedReply(tgCtx);

		const key = chatKey(botKey, tgCtx.chat.id);
		const inst = pool.get(key);
		await runPromptRequest(tgCtx, inst, async ({ supportsImages }) => {
			const loaded = await downloadInboundFileByFileId(
				tgCtx,
				config.token,
				document.file_id,
				String(document.mime_type || "application/octet-stream"),
				supportsImages,
			);
			const currentImages = loaded?.image ? [loaded] : [];
			const currentFilePaths = loaded
				? [normalizePromptPath(loaded.localPath)]
				: [];
			return buildPromptPayloadWithReplyContext(
				tgCtx,
				baseText,
				config.token,
				supportsImages,
				currentImages,
				currentFilePaths,
			);
		});
	});

	// --- finalize ---
	commandGroup
		.setCommands(bot)
		.catch((err) => log.error(`bot${botIndex}`, `setCommands: ${err}`));
	return bot;
}
