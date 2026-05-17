// src/telegram/create-bot.ts — Telegram bot setup, only TG interaction logic
import { createHash } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { Bot, GrammyError, HttpError, type Context, InputFile } from "grammy";
import type { ReplyParameters } from "@grammyjs/types";
import { autoRetry } from "@grammyjs/auto-retry";
import { hydrate, type HydrateFlavor } from "@grammyjs/hydrate";
import { hydrateFiles } from "@grammyjs/files";
import { CommandGroup } from "@grammyjs/commands";
import { Menu } from "@grammyjs/menu";
import { autoChatAction, type AutoChatActionFlavor } from "@grammyjs/auto-chat-action";
import { log } from "../shared/log.js";
import { mdToPlainText, mdToTgHtml } from "./format.js";
import { createBotMenus } from "./menu.js";
import { buildStatusLines } from "./status.js";

import {
  extractTgAttachments,
  type TgAttachment,
  type TgAttachmentKind,
} from "./attachment.js";
import {
  extractTgReplyDirective,
  rememberReplyMessage,
  resolveReplyParameters,
} from "./reply.js";
import {
  extractTgCronDirectives,
  type TgCronDirective,
} from "../cron/directives.js";
import type { PiPool } from "../pi/pool.js";
import type { CronJobRecord, CronSchedule } from "../cron/types.js";
import type { CronService } from "../cron/service.js";
import type { BotConfig } from "../shared/types.js";
import type { PiImage, PiSessionStats } from "../pi/types.js";

type BotContext = HydrateFlavor<Context> & AutoChatActionFlavor;

export interface CreateBotOptions {
  botIndex: number;
  config: BotConfig;
  pool: PiPool;
  cron: CronService;
  maxResponseLength: number;
  initialStreamByChat?: Record<string, boolean>;
  onStreamModeChange?: (chatId: number, enabled: boolean) => Promise<void> | void;
}

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
  const botKey = createHash("sha1").update(config.token).digest("hex").slice(0, 12);

  // --- plugins ---
  bot.api.config.use(hydrateFiles(config.token));
  bot.api.config.use(autoRetry({ maxRetryAttempts: 5, maxDelaySeconds: 60 }));
  bot.use(hydrate());
  bot.use(autoChatAction());

  // --- error handler ---
  bot.catch((err) => {
    const e = err.error;
    if (e instanceof GrammyError) {
      // Ignore stale callback query or idempotent edit
      if (e.description.includes("query is too old")) return;
      if (e.description.includes("message is not modified")) return;
      log.error(`bot${botIndex}`, `TG API: ${e.description}`);
    } else if (e instanceof HttpError) {
      log.error(`bot${botIndex}`, `HTTP: ${e}`);
    } else {
      log.error(`bot${botIndex}`, `${e}`);
    }
  });

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

  // Auth guard
  if (config.allowedUsers.length) {
    bot.use(async (tgCtx, next) => {
      const uid = tgCtx.from?.id;
      const uname = tgCtx.from?.username;
      if (config.allowedUsers.includes(uid!) || config.allowedUsers.includes(uname!)) {
        return next();
      }
      await tgCtx.reply("⛔ Unauthorized");
    });
  }

  const commandGroup = new CommandGroup<BotContext>();
  bot.use(commandGroup);

  const abortNoticeSuppressionByChat = new Map<number, number[]>();
  const ABORT_NOTICE_SUPPRESS_TTL_MS = 15_000;
  const pendingForkMessages = new Map<number, Array<{ entryId: string; text: string }>>();
  type ActivePromptMode = "stream" | "non-stream";
  type ActivePromptState = { token: symbol; mode: ActivePromptMode; done: Promise<void> };
  type AbortDirective = { sendPartial: boolean; showAbortNotice: boolean };
  const activePromptByChat = new Map<number, ActivePromptState>();
  const abortDirectiveByPromptToken = new Map<symbol, AbortDirective>();

  const suppressAbortNotice = (chatId: number, count = 1): void => {
    if (!Number.isSafeInteger(chatId) || count <= 0) return;

    const now = Date.now();
    const list = (abortNoticeSuppressionByChat.get(chatId) ?? [])
      .filter((expiresAt) => expiresAt > now);
    const expiresAt = now + ABORT_NOTICE_SUPPRESS_TTL_MS;

    for (let i = 0; i < count; i += 1) {
      list.push(expiresAt);
    }

    abortNoticeSuppressionByChat.set(chatId, list);
  };

  const consumeAbortNoticeSuppression = (chatId: number): boolean => {
    const now = Date.now();
    const list = abortNoticeSuppressionByChat.get(chatId);
    if (!list?.length) return false;

    const alive = list.filter((expiresAt) => expiresAt > now);
    if (!alive.length) {
      abortNoticeSuppressionByChat.delete(chatId);
      return false;
    }

    alive.shift();
    if (alive.length) {
      abortNoticeSuppressionByChat.set(chatId, alive);
    } else {
      abortNoticeSuppressionByChat.delete(chatId);
    }

    return true;
  };

  const createActivePromptTracker = (chatId: number, mode: ActivePromptMode) => {
    const token = Symbol(`prompt:${chatId}:${mode}`);
    let started = false;
    let finished = false;
    let resolveDone: () => void = () => {};
    const done = new Promise<void>((resolve) => {
      resolveDone = resolve;
    });

    return {
      token,
      onStart: () => {
        if (started) return;
        started = true;
        activePromptByChat.set(chatId, { token, mode, done });
      },
      finish: () => {
        if (finished) return;
        finished = true;
        const current = activePromptByChat.get(chatId);
        if (current?.token === token) {
          activePromptByChat.delete(chatId);
        }
        abortDirectiveByPromptToken.delete(token);
        resolveDone();
      },
      done,
    };
  };

  const cancelQueuedSilently = (chatId: number, inst: ReturnType<PiPool["has"]>): number => {
    if (!inst?.alive) return 0;
    const queued = inst.queuedCount;
    if (queued > 0) {
      suppressAbortNotice(chatId, queued);
      inst.cancelQueued();
    }
    return queued;
  };

  const abortActivePrompt = async (
    chatId: number,
    inst: ReturnType<PiPool["has"]>,
    opts: { sendPartial: boolean; showAbortNotice: boolean },
  ): Promise<{ aborted: boolean; mode?: ActivePromptMode }> => {
    const active = activePromptByChat.get(chatId);
    if (!active || !inst?.alive) return { aborted: false };

    abortDirectiveByPromptToken.set(active.token, {
      sendPartial: opts.sendPartial,
      showAbortNotice: opts.showAbortNotice,
    });
    inst.abort();
    await active.done;
    return { aborted: true, mode: active.mode };
  };

  commandGroup.command("status", "View status", async (tgCtx) => {
    const chatId = tgCtx.chat.id;
    const key = chatKey(botKey, chatId);
    const inst = pool.has(key);
    let modelLabel = "Default";
    let providerLabel = "";
    let thinkingSupported = true;
    let thinkingLabel = "";
    let sessionLabel = "";
    let cost: number | undefined;
    let contextUsage: PiSessionStats["contextUsage"] | undefined;

    if (inst?.alive) {
      try {
        const st = await inst.getState();
        menus.syncState(chatId, st);
        const m = st.model as any;
        if (m?.name) modelLabel = m.name;
        if (m?.provider) providerLabel = String(m.provider);
        if (typeof m?.reasoning === "boolean") {
          thinkingSupported = m.reasoning;
        }
        if (thinkingSupported && st.thinkingLevel) {
          thinkingLabel = String(st.thinkingLevel);
        }
        if (st.sessionId) sessionLabel = String(st.sessionId).slice(0, 8);
      } catch { /* ignore */ }

      try {
        const stats = await inst.getSessionStats();
        if (typeof stats.cost === "number" && stats.cost > 0) {
          cost = stats.cost;
        }
        contextUsage = stats.contextUsage;
      } catch { /* ignore */ }
    }

    const cronSt = cron.status(chatId);
    const lines = buildStatusLines({
      alive: Boolean(inst?.alive),
      processing: Boolean(inst?.streaming),
      providerLabel,
      modelLabel,
      streamEnabled: menus.isStreamEnabled(chatId),
      thinkingLabel,
      sessionLabel,
      cost,
      contextUsage,
      activeCount: pool.size,
      cron: cronSt,
    });

    await tgCtx.reply(lines.join("\n"));
  });

  commandGroup.command("new", "New session", async (tgCtx) => {
    const chatId = tgCtx.chat.id;
    const key = chatKey(botKey, chatId);
    const inst = pool.has(key);

    if (inst?.alive) {
      cancelQueuedSilently(chatId, inst);
      await abortActivePrompt(chatId, inst, {
        sendPartial: true,
        showAbortNotice: true,
      });
    }

    try {
      await pool.getFresh(key);
      await tgCtx.reply("🆕 New session created");
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await tgCtx.reply(`❌ Failed to create session: ${truncate(message, 1000)}`);
    }
  });

  commandGroup.command("kill", "Kill current operation", async (tgCtx) => {
    const chatId = tgCtx.chat.id;
    const key = chatKey(botKey, chatId);
    const inst = pool.has(key);

    if (!inst?.alive) {
      await tgCtx.reply("No active operation");
      return;
    }

    const queued = inst.queuedCount;
    const stopped = await abortActivePrompt(chatId, inst, {
      sendPartial: true,
      showAbortNotice: true,
    });

    if (stopped.aborted) {
      if (queued > 0) {
        await tgCtx.reply(`📥 Queue retained ${queued} items, continuing\nUse /killall to clear the queue`);
      }
      return;
    }

    if (queued > 0) {
      await tgCtx.reply(`No running task, ${queued} items in queue`);
      return;
    }

    await tgCtx.reply("No active operation");
  });

  commandGroup.command("killall", "Kill and clear queue", async (tgCtx) => {
    const chatId = tgCtx.chat.id;
    const key = chatKey(botKey, chatId);
    const inst = pool.has(key);

    if (!inst?.alive || (!inst.running && inst.queuedCount === 0)) {
      await tgCtx.reply("No active operation");
      return;
    }

    const cleared = cancelQueuedSilently(chatId, inst);
    const stopped = await abortActivePrompt(chatId, inst, {
      sendPartial: true,
      showAbortNotice: true,
    });

    if (cleared > 0) {
      await tgCtx.reply(`🧹 Cleared ${cleared} items in queue`);
      return;
    }

    if (!stopped.aborted) {
      await tgCtx.reply("No running task");
    }
  });


  commandGroup.command("compact", "Compact context", async (tgCtx) => {
    const chatId = tgCtx.chat.id;
    const key = chatKey(botKey, chatId);
    const inst = pool.has(key);

    if (!inst?.alive) {
      await tgCtx.reply("Session not started, send a message first");
      return;
    }

    if (inst.streaming) {
      await tgCtx.reply("⏳ Currently generating, /kill first");
      return;
    }

    const instructions = extractCommandArgs(String(tgCtx.message?.text || ""), "compact");
    const status = await tgCtx.reply("⏳ Compacting context...");

    try {
      await inst.compact(instructions || undefined);
      await status.delete().catch(() => {});
      await tgCtx.reply("✅ Context compacted");
    } catch (err) {
      await status.delete().catch(() => {});
      await tgCtx.reply(`❌ Compaction failed: ${truncate((err as Error).message, 1000)}`);
    }
  });

  commandGroup.command("steer", "Steer current task", async (tgCtx) => {
    const chatId = tgCtx.chat.id;
    const key = chatKey(botKey, chatId);
    const inst = pool.has(key);

    if (!inst?.alive) {
      await tgCtx.reply("Session not started");
      return;
    }

    if (!inst.streaming) {
      await tgCtx.reply("No running task");
      return;
    }

    const text = extractCommandArgs(String(tgCtx.message?.text || ""), "steer");
    if (!text.trim()) {
      await tgCtx.reply("Usage: /steer <message>");
      return;
    }

    rememberReplyMessage(replyScopeKey(tgCtx), "user", tgCtx.message!.message_id, text);
    try {
      await inst.steer(text);
      await tgCtx.reply("📤 Steer sent");
    } catch (err) {
      await tgCtx.reply(`❌ Send failed: ${truncate((err as Error).message, 500)}`);
    }
  });

  commandGroup.command("export", "Export session as HTML", async (tgCtx) => {
    const chatId = tgCtx.chat.id;
    const key = chatKey(botKey, chatId);
    const inst = pool.has(key);

    if (!inst?.alive) {
      await tgCtx.reply("Session not started");
      return;
    }

    if (inst.streaming) {
      await tgCtx.reply("⏳ Wait for current task to finish before exporting");
      return;
    }

    try {
      const path = await inst.exportHtml();
      await tgCtx.reply("📄 Session exported");
      await tgCtx.replyWithDocument(new InputFile(path));
    } catch (err) {
      await tgCtx.reply(`❌ Export failed: ${truncate((err as Error).message, 500)}`);
    }
  });

  commandGroup.command("fork", "Fork from history message", async (tgCtx) => {
    const chatId = tgCtx.chat.id;
    const key = chatKey(botKey, chatId);
    const inst = pool.has(key);

    if (!inst?.alive) {
      await tgCtx.reply("Session not started");
      return;
    }

    if (inst.streaming) {
      await tgCtx.reply("⏳ Wait for current task to finish before forking");
      return;
    }

    const status = await tgCtx.reply("⏳ Fetching forkable messages...");

    try {
      const messages = await inst.getForkMessages();
      await status.delete().catch(() => {});

      if (!messages.length) {
        await tgCtx.reply("No forkable messages");
        return;
      }

      const recent = messages.slice(-10);
      const lines = recent.map((m, i) => {
        const preview = truncate(m.text, 80).replace(/\n/g, " ");
        return `${i + 1}. ${preview}`;
      });
      lines.push("", "Reply to this message with the number to fork, e.g.: 3");

      await tgCtx.reply(`📋 Forkable messages (latest ${recent.length} items in queue)：\n${lines.join("\n")}`);
      pendingForkMessages.set(chatId, recent);
    } catch (err) {
      await status.delete().catch(() => {});
      await tgCtx.reply(`❌ Fetch failed: ${truncate((err as Error).message, 500)}`);
    }
  });

  commandGroup.command("undo", "Undo and regenerate", async (tgCtx) => {
    const chatId = tgCtx.chat.id;
    const key = chatKey(botKey, chatId);
    const inst = pool.has(key);

    if (!inst?.alive) {
      await tgCtx.reply("Session not started");
      return;
    }

    if (inst.streaming) {
      await tgCtx.reply("⏳ Wait for current task to finish");
      return;
    }

    try {
      const lastText = await inst.getLastAssistantText();
      if (!lastText) {
        await tgCtx.reply("No replies to undo");
        return;
      }

      const preview = truncate(lastText, 120);
      await tgCtx.reply(`Undoed: "${preview}..."\nSend new instructions or corrections.`);
      rememberReplyMessage(replyScopeKey(tgCtx), "self", tgCtx.message!.message_id, lastText);
    } catch (err) {
      await tgCtx.reply(`❌ Fetch failed: ${truncate((err as Error).message, 500)}`);
    }
  });


  commandGroup.command("model", "Switch model", async (tgCtx) => {
    const chatId = tgCtx.chat.id;

    try {
      await menus.refreshModelsForChat(chatId);
    } catch (err) {
      await tgCtx.reply(`❌ Failed to get model list: ${(err as Error).message}`);
      return;
    }

    await tgCtx.reply("🔄 Select Provider:", { reply_markup: modelMenu });
  });

  commandGroup.command("stream", "Toggle streaming output", async (tgCtx) => {
    await tgCtx.reply("⚙️ Output mode:", { reply_markup: streamMenu });
  });

  commandGroup.command("thinking", "Switch thinking level", async (tgCtx) => {
    const chatId = tgCtx.chat.id;
    const supported = await menus.supportsThinkingForChat(chatId);
    if (!supported) {
      await tgCtx.reply("Current model does not support thinking levels");
      return;
    }
    await menus.ensureThinkingForChat(chatId);
    await tgCtx.reply("🧠 Thinking level:", { reply_markup: thinkingMenu });
  });

  let cronScopeBotId: number | null = null;
  const getCronReplyScope = async (chatId: number): Promise<string> => {
    if (cronScopeBotId == null) {
      const me = await bot.api.getMe();
      cronScopeBotId = me.id;
    }
    return `${cronScopeBotId}:${chatId}`;
  };

  const sendCronAttachment = async (chatId: number, att: TgAttachment): Promise<void> => {
    const api = bot.api;
    const kind = REPLY_BY_KIND[att.kind] || "replyWithDocument";

    try {
      switch (kind) {
        case "replyWithPhoto":
          await api.sendPhoto(chatId, att.media as any);
          return;
        case "replyWithDocument":
          await api.sendDocument(chatId, att.media as any);
          return;
        case "replyWithVideo":
          await api.sendVideo(chatId, att.media as any);
          return;
        case "replyWithAudio":
          await api.sendAudio(chatId, att.media as any);
          return;
        case "replyWithAnimation":
          await api.sendAnimation(chatId, att.media as any);
          return;
        case "replyWithVoice":
          await api.sendVoice(chatId, att.media as any);
          return;
        case "replyWithVideoNote":
          await api.sendVideoNote(chatId, att.media as any);
          return;
        case "replyWithSticker":
          await api.sendSticker(chatId, att.media as any);
          return;
        default:
          await api.sendDocument(chatId, att.media as any);
      }
    } catch (err) {
      if (kind === "replyWithDocument") throw err;
      await api.sendDocument(chatId, att.media as any);
    }
  };

  const sendCronReply = async (chatId: number, text: string, tools: string[]): Promise<void> => {
    const prepared = prepareCronReply(text, tools);
    const scope = await getCronReplyScope(chatId);

    if (prepared.warnings.length) {
      const preview = prepared.warnings.slice(0, 3).join("\n");
      const more = prepared.warnings.length > 3 ? `\n... and ${prepared.warnings.length - 3} items in queue` : "";
      await bot.api.sendMessage(chatId, `⚠️ Attachment parse warnings: \n${preview}${more}`).catch(() => {});
    }

    if (prepared.body.trim()) {
      for (const part of splitMessage(prepared.body, maxResponseLength)) {
        const html = mdToTgHtml(part);
        try {
          const sent = await bot.api.sendMessage(chatId, html, { parse_mode: "HTML" });
          rememberReplyMessage(scope, "self", sent.message_id, part);
        } catch (err) {
          log.warn(`chat${chatId} Cron task HTML send failed, falling back to plain text: ${describeTelegramSendError(err)}`);
          const plain = mdToPlainText(stripProtocolTags(part));
          const sent = await bot.api.sendMessage(chatId, plain);
          rememberReplyMessage(scope, "self", sent.message_id, plain);
        }
      }
    }

    for (const att of prepared.attachments) {
      try {
        await sendCronAttachment(chatId, att);
      } catch (err) {
        await bot.api.sendMessage(chatId, `❌ Attachment send failed: ${att.label || "Unknown attachment"}\n${(err as Error).message}`).catch(() => {});
      }
    }
  };

  cron.setExecutor(async ({ job }) => {
    const key = chatKey(botKey, job.chatId);
    const inst = pool.get(key);

    try {
      const result = await inst.prompt(job.prompt);
      await sendCronReply(job.chatId, result.text, result.tools);
      return { ok: true };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await bot.api.sendMessage(
        job.chatId,
        `❌ Cron task "${job.name || job.id}" execution failed: ${truncate(message, 1500)}`,
      ).catch(() => {});
      return { ok: false, error: message };
    }
  });

  type CronPendingInput =
    | { kind: "at" | "every" | "cron"; startedAt: number }
    | { kind: "rename"; jobId: string; startedAt: number };
  const cronPendingInput = new Map<number, CronPendingInput>();
  const cronMenuPageByChat = new Map<number, number>();
  const cronMenuMessageByChat = new Map<number, number>();
  const cronRootMenuId = `cron-menu-${botIndex}`;
  const CRON_MENU_PAGE_SIZE = 6;

  const buildCronMenuTitle = (chatId: number): string => {
    const pending = cronPendingInput.get(chatId);
    const hint = pending
      ? `\nAwaiting input: ${pending.kind} (send text directly, or cancel in menu)`
      : "";
    return `⏰ Cron task menu${hint}`;
  };

  const setCronMenuPage = (chatId: number, page: number, totalPages: number): number => {
    const safeTotal = Math.max(1, totalPages);
    const next = Math.max(0, Math.min(page, safeTotal - 1));
    cronMenuPageByChat.set(chatId, next);
    return next;
  };

  const upsertCronMenuMessage = async (tgCtx: BotContext): Promise<void> => {
    const chatId = tgCtx.chat?.id ?? 0;
    const text = buildCronMenuTitle(chatId);
    const existingId = cronMenuMessageByChat.get(chatId);

    await ensureCronMenuReady(tgCtx);

    if (existingId) {
      try {
        await tgCtx.api.editMessageText(chatId, existingId, text, { reply_markup: cronMenu });
        return;
      } catch (err) {
        if (isMessageNotModifiedError(err)) return;
        cronMenuMessageByChat.delete(chatId);
        log.warn(`chat${chatId} Failed to update /cron menu, will try resending: ${describeTelegramSendError(err)}`);
      }
    }

    const sent = await tgCtx.reply(text, { reply_markup: cronMenu });
    cronMenuMessageByChat.set(chatId, sent.message_id);
  };

  const cronMenu = new Menu<BotContext>(cronRootMenuId, {
    onMenuOutdated: "Menu updated, please retry",
    fingerprint: (ctx) => {
      const chatId = ctx.chat?.id ?? 0;
      const st = cron.status(chatId);
      const pending = cronPendingInput.get(chatId);
      const page = cronMenuPageByChat.get(chatId) ?? 0;
      const jobs = cron.list(chatId)
        .slice(0, 60)
        .map((x) => `${x.id}:${x.enabled ? 1 : 0}:${x.updatedAtMs}:${x.state.runningRunId ? 1 : 0}`)
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
      cronMenuMessageByChat.set(chatId, menuMessageId);
    }
    const st = cron.status(chatId);
    const jobs = cron.list(chatId);
    const pending = cronPendingInput.get(chatId);

    const totalPages = Math.max(1, Math.ceil(jobs.length / CRON_MENU_PAGE_SIZE));
    const rawPage = cronMenuPageByChat.get(chatId) ?? 0;
    const page = setCronMenuPage(chatId, rawPage, totalPages);
    const start = page * CRON_MENU_PAGE_SIZE;
    const pageJobs = jobs.slice(start, start + CRON_MENU_PAGE_SIZE);

    range.text(
      `📊 ${st.enabled ? "On" : "Off"} | Tasks ${st.totalJobs} | Running ${st.runningJobs} | Queued ${st.queuedJobs}`,
      (ctx) => ctx.answerCallbackQuery({ text: "Status updated" }),
    ).row();

    range.text("🔄 Refresh", async (ctx) => {
      try { ctx.menu.update(); } catch { /* ignore */ }
      await ctx.answerCallbackQuery({ text: "Refreshed" });
    });

    range.text("➕ One-time", async (ctx) => {
      cronPendingInput.set(chatId, { kind: "at", startedAt: Date.now() });
      await ctx.answerCallbackQuery({ text: "Send: <ISO time> <content>" });
      await ctx.reply("🕒 Enter one-time task: \n<ISO time> <content>\nWith name: <ISO time> <name||content>\nExample: 2026-03-01T09:00:00+08:00 Morning briefing");
      try { ctx.menu.update(); } catch { /* ignore */ }
    }).row();

    range.text("➕ Interval", async (ctx) => {
      cronPendingInput.set(chatId, { kind: "every", startedAt: Date.now() });
      await ctx.answerCallbackQuery({ text: "Send: <interval> <content>" });
      await ctx.reply("⏱ Enter interval task: \n<interval> <content>\nWith name: <interval> <name||content>\nExample: 10m Check alerts\nSupported: s/m/h/d");
      try { ctx.menu.update(); } catch { /* ignore */ }
    });

    range.text("➕ Cron", async (ctx) => {
      cronPendingInput.set(chatId, { kind: "cron", startedAt: Date.now() });
      await ctx.answerCallbackQuery({ text: "Send: <expression> | [timezone] | [name] | <content>" });
      await ctx.reply("🧩 Enter Cron task: \n<expression> | [timezone] | [name] | <content>\nExample: 0 9 * * 1-5 | Asia/Shanghai | Weekday briefing | Daily summary");
      try { ctx.menu.update(); } catch { /* ignore */ }
    }).row();

    if (pending) {
      const ageSec = Math.max(0, Math.floor((Date.now() - pending.startedAt) / 1000));
      range.text(`❌ Cancel input (${pending.kind}, ${ageSec}s)`, async (ctx) => {
        cronPendingInput.delete(chatId);
        try { ctx.menu.update(); } catch { /* ignore */ }
        await ctx.answerCallbackQuery({ text: "Cancelled" });
      }).row();
    }

    if (!jobs.length) {
      range.text("No tasks", (ctx) => ctx.answerCallbackQuery({ text: "No tasks yet" }));
      return;
    }

    range.text(`📄 Page ${page + 1}/${totalPages}`, (ctx) =>
      ctx.answerCallbackQuery({ text: `${pageJobs.length} items in queue` }),
    ).row();

    for (const job of pageJobs) {
      const icon = job.enabled ? "🟢" : "⚪";
      const running = job.state.runningRunId ? " ⏳" : "";
      range.text(`${icon}${running} ${truncate(job.name, 18)} [${job.id}]`, (ctx) =>
        ctx.answerCallbackQuery({ text: `${formatCronSchedule(job.schedule)} | next=${formatDateTime(job.state.nextRunAtMs)}`.slice(0, 190) }),
      ).row();

      range.text(job.enabled ? "⏸ Disable" : "▶️ Enable", async (ctx) => {
        await cron.setEnabled(job.id, !job.enabled);
        try { ctx.menu.update(); } catch { /* ignore */ }
        await ctx.answerCallbackQuery({ text: job.enabled ? "Disabled" : "Enabled" });
      });

      range.text("▶️ Run", async (ctx) => {
        const ok = await cron.runNow(job.id);
        try { ctx.menu.update(); } catch { /* ignore */ }
        await ctx.answerCallbackQuery({ text: ok ? "Added to execution queue" : "Failed to add" });
      });

      range.text("✏️ Rename", async (ctx) => {
        cronPendingInput.set(chatId, { kind: "rename", jobId: job.id, startedAt: Date.now() });
        try { ctx.menu.update(); } catch { /* ignore */ }
        await ctx.answerCallbackQuery({ text: "Send new name" });
        await ctx.reply(`✏️ Send new name for task ${job.id}`);
      }).row();

      range.text("🗑 Delete", async (ctx) => {
        await cron.remove(job.id);
        const nextTotalPages = Math.max(1, Math.ceil(Math.max(0, jobs.length - 1) / CRON_MENU_PAGE_SIZE));
        setCronMenuPage(chatId, page, nextTotalPages);
        try { ctx.menu.update(); } catch { /* ignore */ }
        await ctx.answerCallbackQuery({ text: "Deleted" });
      }).row();
    }

    if (totalPages > 1) {
      range.text("⬅️ Prev", async (ctx) => {
        setCronMenuPage(chatId, page - 1, totalPages);
        try { ctx.menu.update(); } catch { /* ignore */ }
        await ctx.answerCallbackQuery({ text: `Page ${Math.max(1, page)}` });
      });

      range.text("➡️ Next", async (ctx) => {
        setCronMenuPage(chatId, page + 1, totalPages);
        try { ctx.menu.update(); } catch { /* ignore */ }
        await ctx.answerCallbackQuery({ text: `Page ${Math.min(totalPages, page + 2)}` });
      }).row();
    }
  });

  bot.use(cronMenu);

  const ensureCronMenuReady = async (tgCtx: BotContext): Promise<void> => {
    await cronMenu.middleware()(tgCtx, async () => {});
  };

  commandGroup.command("cron", "Manage cron tasks", async (tgCtx) => {
    try {
      const raw = extractCommandArgs(String((tgCtx.message as any)?.text || ""), "cron");
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
        await tgCtx.reply("No cron tasks in this chat. Use /cron add ... to create one.");
        return;
      }

      const lines = jobs.map((job) => formatCronJobLine(job));
      const text = `⏰ Cron tasks (${jobs.length})\n${lines.join("\n")}`;
      for (const part of splitMessage(text, maxResponseLength)) {
        await tgCtx.reply(part);
      }
      return;
    }

    if (sub === "stat" || sub === "status") {
      const st = cron.status(chatId);
      await tgCtx.reply(formatCronStatus(st));
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
        const prompt = named.prompt;
        if (!atRaw || !prompt) {
          await tgCtx.reply("Usage: /cron add at <ISO time> <content>");
          return;
        }

        const atMs = new Date(atRaw).getTime();
        if (!Number.isFinite(atMs)) {
          await tgCtx.reply("Invalid time format, use ISO 8601, e.g. 2026-03-01T09:00:00+08:00");
          return;
        }

        const job = await cron.create({
          chatId,
          name: named.name,
          prompt,
          schedule: { kind: "at", atMs },
        });
        await tgCtx.reply(`✅ Task created ${job.id}\n${formatCronSchedule(job.schedule)}\nName: ${job.name}`);
        return;
      }

      if (kind === "every") {
        const everyRaw = args.shift() || "";
        const named = parseNamedPrompt(args.join(" "));
        const prompt = named.prompt;
        const everyMs = parseDurationMs(everyRaw);
        if (!everyMs || !prompt) {
          await tgCtx.reply("Usage: /cron add every <interval> <content>\nExample: /cron add every 10m Morning briefing");
          return;
        }

        const job = await cron.create({
          chatId,
          name: named.name,
          prompt,
          schedule: { kind: "every", everyMs, anchorMs: Date.now() },
        });
        await tgCtx.reply(`✅ Task created ${job.id}\n${formatCronSchedule(job.schedule)}\nName: ${job.name}`);
        return;
      }

      if (kind === "cron") {
        const expr = args.shift() || "";
        if (!expr) {
          await tgCtx.reply("Usage: /cron add cron \"<expression>\" [timezone] <content>");
          return;
        }

        let timezone = cron.getDefaultTimezone();
        if (args.length >= 2 && looksLikeTimezone(args[0])) {
          timezone = args.shift()!;
        }

        const named = parseNamedPrompt(args.join(" "));
        const prompt = named.prompt;
        if (!prompt) {
          await tgCtx.reply("Usage: /cron add cron \"<expression>\" [timezone] <content>");
          return;
        }

        const job = await cron.create({
          chatId,
          name: named.name,
          prompt,
          schedule: { kind: "cron", expr, timezone },
        });

        await tgCtx.reply(`✅ Task created ${job.id}\n${formatCronSchedule(job.schedule)}\nName: ${job.name}`);
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
      await tgCtx.reply(`✅ Task ${id} ${sub === "on" ? "enabled" : "disabled"}`);
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
      await tgCtx.reply(ok ? `▶️ Task ${id} added to queue` : "Failed to add to queue");
      return;
    }

    await tgCtx.reply("Unknown subcommand. Send /cron help for usage.");
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await tgCtx.reply(`❌ Cron operation failed: ${truncate(message, 1000)}`).catch(() => {});
  }
});

  type PromptPayload = { message: string; images?: PiImage[] };
  type PromptBuildOptions = { supportsImages: boolean };

  const imageSupportCache = new Map<number, { value: boolean; at: number }>();
  const draftCounterByChat = new Map<number, number>();

  function nextDraftId(chatId: number): number {
    const prev = draftCounterByChat.get(chatId) ?? 0;
    // Keep draft_id in a safe positive 31-bit range.
    const next = prev >= 2_000_000_000 ? 1 : prev + 1;
    draftCounterByChat.set(chatId, next);
    return next;
  }

  function getMessageThreadId(tgCtx: BotContext): number | undefined {
    const raw = Number((tgCtx.message as any)?.message_thread_id);
    if (!Number.isSafeInteger(raw) || raw <= 0) return undefined;
    return raw;
  }

  function shouldUseDraftStreaming(tgCtx: BotContext): boolean {
    const chat = tgCtx.chat as any;
    if (!chat) return false;
    // Bot API currently supports draft streaming for private chats.
    return chat.type === "private";
  }

  async function supportsImagesForChat(
    chatId: number,
    inst: ReturnType<PiPool["get"]>,
  ): Promise<boolean> {
    const cached = imageSupportCache.get(chatId);
    const now = Date.now();
    if (cached && now - cached.at < 30_000) return cached.value;

    let value = true;
    try {
      const st = await inst.getState();
      const model = (st as any)?.model;
      let parsed = parseModelImageSupport(model);

      if (typeof parsed !== "boolean" && model?.provider && model?.id) {
        try {
          const models = await inst.getAvailableModels();
          const selected = models.find(
            (m: any) => m.provider === model.provider && m.id === model.id,
          );
          parsed = parseModelImageSupport(selected);
        } catch {
          // ignore lookup failures
        }
      }

      if (typeof parsed === "boolean") value = parsed;
    } catch {
      // ignore and keep default true
    }

    imageSupportCache.set(chatId, { value, at: now });
    return value;
  }

  const reportStatusOrReply = async (
    tgCtx: BotContext,
    status: { delete?: () => Promise<unknown>; editText: (text: string, other?: Record<string, unknown>) => Promise<unknown> },
    text: string,
  ): Promise<void> => {
    const safe = truncate(text, 3500);
    await status.delete?.().catch(() => {});
    await tgCtx.reply(safe).catch(async () => {
      try {
        await status.editText(safe);
      } catch {
        // ignore final fallback failure
      }
    });
  };

  const executeCronDirectiveForChat = async (
    chatId: number,
    directive: TgCronDirective,
  ): Promise<{ notices: string[]; warnings: string[] }> => {
    const notices: string[] = [];
    const warnings: string[] = [];

    const ensureOwned = (id: string): CronJobRecord => {
      const job = cron.get(id);
      if (!job || job.chatId !== chatId) {
        throw new Error("Job not found (or not in this chat)");
      }
      return job;
    };

    switch (directive.action) {
      case "list": {
        const jobs = cron.list(chatId);
        if (!jobs.length) {
          notices.push("⏰ No cron tasks in this chat.");
          break;
        }
        notices.push(`⏰ Cron tasks (${jobs.length})\n${jobs.map((x) => formatCronJobLine(x)).join("\n")}`);
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
          const atRaw = String(directive.at || "").trim();
          const atMs = new Date(atRaw).getTime();
          if (!Number.isFinite(atMs)) {
            throw new Error("add kind=at: invalid at time (ISO time required)");
          }
          schedule = { kind: "at", atMs };
        } else if (kind === "every") {
          const everyMs = parseDurationMs(String(directive.every || "").trim());
          if (!everyMs) {
            throw new Error("add kind=every: invalid every value (e.g. 10m/2h/1d)");
          }
          schedule = { kind: "every", everyMs, anchorMs: Date.now() };
        } else {
          const expr = String(directive.expr || "").trim();
          if (!expr) throw new Error("add kind=cron missing expr");

          const tzRaw = String(directive.timezone || "").trim();
          const timezone = tzRaw || cron.getDefaultTimezone();
          if (!looksLikeTimezone(timezone)) {
            throw new Error(`Invalid timezone: ${timezone}`);
          }
          schedule = { kind: "cron", expr, timezone };
        }

        const created = await cron.create({
          chatId,
          name: directive.name,
          prompt,
          schedule,
        });

        notices.push(`✅ Task created ${created.id}\n${formatCronSchedule(created.schedule)}\nName: ${created.name}`);
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
        notices.push(ok ? `▶️ Task ${id} added to queue` : `❌ Task ${id} failed to add to queue`);
        break;
      }

      default:
        warnings.push(`Unsupported tg-cron action: ${(directive as any).action}`);
        break;
    }

    return { notices, warnings };
  };

  const applyCronToolDirectives = async (
    tgCtx: BotContext,
    text: string,
  ): Promise<{ text: string; warnings: string[] }> => {
    const extracted = extractTgCronDirectives(text || "");
    const warnings = [...extracted.warnings];
    const notices: string[] = [];
    const chatId = tgCtx.chat?.id ?? 0;

    for (const directive of extracted.directives) {
      try {
        const res = await executeCronDirectiveForChat(chatId, directive);
        notices.push(...res.notices);
        warnings.push(...res.warnings);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        warnings.push(`tg-cron(${directive.action}) execution failed: ${message}`);
      }
    }

    const mergedText = [extracted.text.trim(), ...notices].filter(Boolean).join("\n\n");
    return { text: mergedText, warnings };
  };

  const consumePendingCronInput = async (
    tgCtx: BotContext,
    pending: CronPendingInput,
    text: string,
  ): Promise<boolean> => {
    const chatId = tgCtx.chat?.id ?? 0;
    const raw = String(text || "").trim();
    if (!raw) return true;

    try {
      if (pending.kind === "rename") {
        const job = cron.get(pending.jobId);
        if (!job || job.chatId !== chatId) {
          cronPendingInput.delete(chatId);
          await tgCtx.reply("❌ Target task not found or not in this chat");
          return true;
        }

        const updated = await cron.rename(pending.jobId, raw);
        cronPendingInput.delete(chatId);
        await upsertCronMenuMessage(tgCtx);
        if (!updated) {
          await tgCtx.reply("❌ Rename failed");
          return true;
        }

        await tgCtx.reply(`✏️ Task ${updated.id} renamed to: ${updated.name}`);
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
        const prompt = named.prompt;
        const atMs = new Date(atRaw).getTime();

        if (!Number.isFinite(atMs) || !prompt) {
          await tgCtx.reply("❌ Invalid format, send: <ISO time> <content>");
          return true;
        }

        const job = await cron.create({
          chatId,
          name: named.name,
          prompt,
          schedule: { kind: "at", atMs },
        });

        cronPendingInput.delete(chatId);
        await upsertCronMenuMessage(tgCtx);
        await tgCtx.reply(`✅ Task created ${job.id}\n${formatCronSchedule(job.schedule)}\nName: ${job.name}`);
        return true;
      }

      if (pending.kind === "every") {
        const firstSpace = raw.indexOf(" ");
        if (firstSpace < 0) {
          await tgCtx.reply("❌ Invalid format. Usage: <interval> <content>, Example: 10m Check alerts");
          return true;
        }

        const everyRaw = raw.slice(0, firstSpace).trim();
        const named = parseNamedPrompt(raw.slice(firstSpace + 1));
        const prompt = named.prompt;
        const everyMs = parseDurationMs(everyRaw);

        if (!everyMs || !prompt) {
          await tgCtx.reply("❌ Invalid interval format. Supported: s/m/h/d (e.g. 30s, 10m, 2h, 1d)");
          return true;
        }

        const job = await cron.create({
          chatId,
          name: named.name,
          prompt,
          schedule: { kind: "every", everyMs, anchorMs: Date.now() },
        });

        cronPendingInput.delete(chatId);
        await upsertCronMenuMessage(tgCtx);
        await tgCtx.reply(`✅ Task created ${job.id}\n${formatCronSchedule(job.schedule)}\nName: ${job.name}`);
        return true;
      }

      // pending.kind === "cron"
      const parts = raw.split("|").map((x) => x.trim()).filter(Boolean);
      if (parts.length < 2) {
        await tgCtx.reply("❌ Invalid format. Usage: <expression> | [timezone] | [name] | <content>");
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
        await tgCtx.reply("❌ Missing task content. Usage: <expression> | [timezone] | [name] | <content>");
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

      cronPendingInput.delete(chatId);
      await upsertCronMenuMessage(tgCtx);
      await tgCtx.reply(`✅ Task created ${job.id}\n${formatCronSchedule(job.schedule)}\nName: ${job.name}`);
      return true;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await tgCtx.reply(`❌ Task creation failed: ${truncate(message, 800)}\nYou can continue typing, or cancel in /cron menu`).catch(() => {});
      return true;
    }
  };

  const runPromptRequest = async (
    tgCtx: BotContext,
    inst: ReturnType<PiPool["get"]>,
    makePayload: (opts: PromptBuildOptions) => Promise<PromptPayload>,
  ): Promise<void> => {
    const ahead = inst.queuedCount + (inst.running ? 1 : 0);
    const chatId = tgCtx.chat?.id ?? 0;
    const useStream = menus.isStreamEnabled(chatId);
    const useDraftStream = useStream && shouldUseDraftStreaming(tgCtx);

    const initialStatus = ahead > 0
      ? `⏳ Queued (${ahead} items in queue)...`
      : "⏳ Thinking...";
    const status = !useStream
      ? await tgCtx.reply(initialStatus)
      : null;

    let streamedText = "";
    tgCtx.chatAction = "typing";

    const promptTracker = createActivePromptTracker(chatId, useStream ? "stream" : "non-stream");
    const onStart = () => {
      promptTracker.onStart();
      if (!status || ahead <= 0) return;
      void status.editText("⏳ Thinking...").catch(() => {});
    };

    try {
      const supportsImages = await supportsImagesForChat(chatId, inst);
      const { message, images } = await makePayload({ supportsImages });
      const promptMessage = message;

      if (useStream) {
        const stream = useDraftStream
          ? createDraftStreamUpdater(
            tgCtx.api,
            chatId,
            nextDraftId(chatId),
            getMessageThreadId(tgCtx),
            maxResponseLength,
            (err) => {
              log.warn(`chat${chatId} sendMessageDraft preview failed, skipping: ${describeTelegramSendError(err)}`);
            },
          )
          : createSilentStreamUpdater();

        try {
          const result = await inst.prompt(promptMessage, images, {
            onStart,
            onTextDelta: (delta, fullText) => {
              streamedText = stripProtocolTags(fullText);
              stream.onTextDelta(delta, fullText);
            },
            onToolStart: stream.onToolStart,
            onToolError: stream.onToolError,
          });

          await stream.stopAndWait();
          const processed = await applyCronToolDirectives(tgCtx, result.text);

          await sendReply(tgCtx, processed.text, result.tools, maxResponseLength, processed.warnings);
          await maybeWarnContextFull(tgCtx, inst);
        } finally {
          await stream.stopAndWait();
        }

        return;
      }

      const result = await inst.prompt(promptMessage, images, {
        onStart,
        onTextDelta: (_delta, fullText) => {
          streamedText = stripProtocolTags(fullText);
        },
      });
      await status?.delete().catch(() => {});
      const processed = await applyCronToolDirectives(tgCtx, result.text);
      await sendReply(tgCtx, processed.text, result.tools, maxResponseLength, processed.warnings);
      await maybeWarnContextFull(tgCtx, inst);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message === "aborted") {
        const abortDirective = abortDirectiveByPromptToken.get(promptTracker.token);
        if (abortDirective) {
          abortDirectiveByPromptToken.delete(promptTracker.token);
          await status?.delete().catch(() => {});

          const partial = stripProtocolTags(streamedText).trim();
          if (abortDirective.sendPartial && partial) {
            await sendPreparedReply(
              tgCtx,
              { body: partial, attachments: [], warnings: [] },
              maxResponseLength,
            ).catch(() => {});
          }

          if (abortDirective.showAbortNotice) {
            await tgCtx.reply("💀 Killed").catch(() => {});
          }
        } else if (consumeAbortNoticeSuppression(chatId)) {
          await status?.delete().catch(() => {});
        } else if (status) {
          await reportStatusOrReply(tgCtx, status, "💀 Killed");
        } else {
          await tgCtx.reply("💀 Killed").catch(() => {});
        }
      } else if (useStream && streamedText.trim()) {
        const errLine = `⚠️ Generation interrupted: ${truncate(message, 300)}`;
        const merged = truncate(`${streamedText}\n\n${errLine}`, maxResponseLength);
        if (status) {
          await reportStatusOrReply(tgCtx, status, merged);
        } else {
          await tgCtx.reply(merged).catch(() => {});
        }
      } else {
        const errorText = `❌ Error: ${message}`;
        if (status) {
          await reportStatusOrReply(tgCtx, status, errorText);
        } else {
          await tgCtx.reply(errorText).catch(() => {});
        }
      }
    } finally {
      promptTracker.finish();
      tgCtx.chatAction = null;
    }
  };

  // Text messages
  bot.on("message:text", async (tgCtx) => {
    const text = tgCtx.message.text;
    if (!text) return;
    if (text.startsWith("/")) return;

    const pending = cronPendingInput.get(tgCtx.chat.id);
    if (pending) {
      const handled = await consumePendingCronInput(tgCtx, pending, text);
      if (handled) return;
    }

    // Handle pending fork selection (number input after /fork)
    const forkMessages = pendingForkMessages.get(tgCtx.chat.id);
    if (forkMessages) {
      const num = parseInt(text.trim(), 10);
      if (Number.isFinite(num) && num >= 1 && num <= forkMessages.length) {
        const selected = forkMessages[num - 1];
        pendingForkMessages.delete(tgCtx.chat.id);
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
          await tgCtx.reply(`✅ Forked from message ${num}\n${truncate(result.text, 100)}`);
        } catch (err) {
          await status.delete().catch(() => {});
          await tgCtx.reply(`❌ Fork failed: ${truncate((err as Error).message, 500)}`);
        }
        return;
      }
      // Non-number input after /fork — clear pending state and fall through
      pendingForkMessages.delete(tgCtx.chat.id);
    }

    rememberReplyMessage(replyScopeKey(tgCtx), "user", tgCtx.message.message_id, text);
    rememberReferencedReply(tgCtx);

    const key = chatKey(botKey, tgCtx.chat.id);
    const inst = pool.get(key);

    await runPromptRequest(tgCtx, inst, async ({ supportsImages }) =>
      buildPromptPayloadWithReplyContext(tgCtx, text, config.token, supportsImages),
    );
  });

  // Photos
  bot.on("message:photo", async (tgCtx) => {
    const caption = tgCtx.message.caption || "Please describe this image";
    rememberReplyMessage(replyScopeKey(tgCtx), "user", tgCtx.message.message_id, caption);
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
      const currentImages = image ? [image] : [];

      return buildPromptPayloadWithReplyContext(
        tgCtx,
        caption,
        config.token,
        supportsImages,
        currentImages,
      );
    });
  });

  // Generic files (documents)
  bot.on("message:document", async (tgCtx) => {
    const document = tgCtx.message.document;
    const baseText = tgCtx.message.caption || document.file_name || "Please process this file";
    rememberReplyMessage(replyScopeKey(tgCtx), "user", tgCtx.message.message_id, baseText);
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
      const currentFilePaths = loaded ? [normalizePromptPath(loaded.localPath)] : [];

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

  // Sync command menu from command group definitions
  commandGroup.setCommands(bot)
    .catch((err) => log.error(`bot${botIndex}`, `setCommands: ${err}`));

  return bot;
}

// --- helpers (private to this module) ---

function chatKey(botKey: string, chatId: number): string {
  return `bot${botKey}_chat${chatId}`;
}

function replyScopeKey(tgCtx: BotContext): string {
  return `${tgCtx.me.id}:${tgCtx.chat?.id ?? 0}`;
}

const inboundDirCache = new Set<string>();

function rememberReferencedReply(tgCtx: BotContext): void {
  const current = tgCtx.message as any;
  const replied = current?.reply_to_message as any;
  if (!replied?.message_id) return;

  const text = extractMessageText(replied) || String(current?.quote?.text || "").trim();
  if (!text) return;

  const role = replied?.from?.id === tgCtx.me.id ? "self" : "user";
  rememberReplyMessage(replyScopeKey(tgCtx), role, replied.message_id, text);
}

interface LoadedImage {
  fileId: string;
  localPath: string;
  contentHash?: string;
  image?: PiImage;
}

interface ReplyContextOptions {
  currentImagePaths?: string[];
  referencedImagePaths?: string[];
  currentFilePaths?: string[];
}

async function buildPromptPayloadWithReplyContext(
  tgCtx: BotContext,
  content: string,
  token: string,
  enableImages: boolean,
  currentImages: LoadedImage[] = [],
  currentFilePaths: string[] = [],
): Promise<{ message: string; images?: PiImage[] }> {
  const dedupeIds = new Set(currentImages.map((x) => x.fileId.toLowerCase()));
  const referencedImages = await collectReferencedImages(tgCtx, token, dedupeIds, enableImages);

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
  opts: ReplyContextOptions = {},
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
    !!targetText
    || !!quote
    || referencedImagePaths.length > 0
    || currentImagePaths.length > 0
    || currentFilePaths.length > 0;

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

  return [
    ...replyBlock,
    "",
    "[User's actual request]",
    content,
  ].join("\n");
}

async function collectReferencedImages(
  tgCtx: BotContext,
  token: string,
  seenFileIds: Set<string> = new Set(),
  includeImage = true,
): Promise<LoadedImage[]> {
  const current = tgCtx.message as any;
  const replied = current?.reply_to_message as any;
  if (!replied) return [];

  const images: LoadedImage[] = [];

  if (Array.isArray(replied.photo) && replied.photo.length > 0) {
    const photo = replied.photo[replied.photo.length - 1];
    const key = String(photo.file_id || "").toLowerCase();
    if (key && !seenFileIds.has(key)) {
      seenFileIds.add(key);
      const img = await downloadImageByFileId(tgCtx, token, photo.file_id, "image/jpeg", includeImage);
      if (img) images.push(img);
    }
  }

  if (replied.document?.file_id && String(replied.document?.mime_type || "").startsWith("image/")) {
    const key = String(replied.document.file_id || "").toLowerCase();
    if (key && !seenFileIds.has(key)) {
      seenFileIds.add(key);
      const img = await downloadImageByFileId(
        tgCtx,
        token,
        replied.document.file_id,
        String(replied.document?.mime_type || "image/jpeg"),
        includeImage,
      );
      if (img) images.push(img);
    }
  }

  return images;
}

async function downloadImageByFileId(
  tgCtx: BotContext,
  token: string,
  fileId: string,
  fallbackMimeType = "image/jpeg",
  includeImage = true,
): Promise<LoadedImage | null> {
  const loaded = await downloadInboundFileByFileId(
    tgCtx,
    token,
    fileId,
    fallbackMimeType,
    includeImage,
  );
  if (!loaded) return null;
  if (!loaded.image) return null;
  return loaded;
}

async function downloadInboundFileByFileId(
  tgCtx: BotContext,
  token: string,
  fileId: string,
  fallbackMimeType = "application/octet-stream",
  includeImage = true,
): Promise<LoadedImage | null> {
  try {
    const file = await tgCtx.api.getFile(fileId) as any;
    if (!file?.file_path) return null;

    const filePath = String(file.file_path);
    const mimeType = inferImageMimeFromPath(filePath, fallbackMimeType);
    const ext = inferImageExtFromPath(filePath, mimeType);
    const localPath = resolveInboundImagePath(tgCtx, fileId, ext);

    let buffer: Buffer | null = null;

    const hasLocal = existsSync(localPath);

    if (!hasLocal) {
      let downloaded = false;

      if (typeof file.download === "function") {
        try {
          await file.download(localPath);
          downloaded = true;
        } catch {
          downloaded = false;
        }
      }

      if (!downloaded) {
        const url = `https://api.telegram.org/file/bot${token}/${filePath}`;
        const resp = await fetch(url);
        if (!resp.ok) return null;
        buffer = Buffer.from(await resp.arrayBuffer());
        await writeFile(localPath, buffer);
      }
    }

    let contentHash: string | undefined;

    const isImage = mimeType.startsWith("image/");
    if (includeImage && isImage) {
      if (!buffer) {
        buffer = await readFile(localPath);
      }
      contentHash = hashImageBuffer(buffer);
      return {
        fileId,
        localPath,
        contentHash,
        image: {
          type: "image",
          data: buffer.toString("base64"),
          mimeType,
        },
      };
    }

    if (!buffer && isImage) {
      buffer = await readFile(localPath);
      contentHash = hashImageBuffer(buffer);
    }

    return { fileId, localPath, contentHash };
  } catch {
    return null;
  }
}

function inferImageMimeFromPath(path: string, fallback: string): string {
  const ext = path.split(".").pop()?.toLowerCase() || "";
  const mimeMap: Record<string, string> = {
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    png: "image/png",
    gif: "image/gif",
    webp: "image/webp",
    bmp: "image/bmp",
    tif: "image/tiff",
    tiff: "image/tiff",
  };
  return mimeMap[ext] || fallback;
}

function inferImageExtFromPath(path: string, mimeType: string): string {
  const ext = path.split(".").pop()?.toLowerCase() || "";
  if (ext) return ext;
  return inferImageExtFromMime(mimeType);
}

function inferImageExtFromMime(mimeType: string): string {
  const map: Record<string, string> = {
    "image/jpeg": "jpg",
    "image/png": "png",
    "image/gif": "gif",
    "image/webp": "webp",
    "image/bmp": "bmp",
    "image/tiff": "tiff",
  };
  return map[mimeType] || "img";
}

function hashImageBuffer(buffer: Buffer): string {
  return createHash("sha256").update(buffer).digest("hex");
}

function resolveInboundImagePath(
  tgCtx: BotContext,
  fileId: string,
  ext: string,
): string {
  const dir = resolve(
    homedir(),
    ".pi",
    "telegram",
    "inbound",
    String(tgCtx.me.id),
    String(tgCtx.chat?.id ?? 0),
  );
  if (!inboundDirCache.has(dir)) {
    mkdirSync(dir, { recursive: true });
    inboundDirCache.add(dir);
  }

  const filename = `${sanitizeFileToken(fileId)}.${sanitizeFileToken(ext || "img")}`;
  return resolve(dir, filename);
}

function sanitizeFileToken(s: string): string {
  const cleaned = s.replace(/[^a-zA-Z0-9._-]/g, "_");
  return cleaned.slice(0, 120) || "file";
}

function normalizePromptPath(p: string): string {
  return p.replace(/\\/g, "/");
}

function extractMessageText(msg: any): string {
  if (!msg) return "";

  const text = String(msg.text || "").trim();
  const caption = String(msg.caption || "").trim();
  if (text && caption) return `${text}\n${caption}`;
  return text || caption;
}

function formatMessageSender(msg: any, meId: number): string {
  if (!msg) return "";
  if (msg.from?.id === meId) return "self";
  if (msg.from?.username) return `@${msg.from.username}`;
  if (msg.from?.first_name) return msg.from.first_name;
  if (msg.sender_chat?.title) return msg.sender_chat.title;
  return "user";
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max)}…`;
}

const CONTEXT_WARN_THRESHOLD = 0.85;

async function maybeWarnContextFull(tgCtx: BotContext, inst: ReturnType<PiPool["get"]>): Promise<void> {
  if (!inst?.alive) return;
  try {
    const stats = await inst.getSessionStats();
    const usage = stats?.contextUsage;
    if (!usage || typeof usage.percent !== "number" || usage.percent < CONTEXT_WARN_THRESHOLD) return;
    const pct = usage.percent.toFixed(0);
    const used = typeof usage.tokens === "number" ? usage.tokens : "?";
    const total = typeof usage.contextWindow === "number" ? usage.contextWindow : "?";
    await tgCtx.reply(`⚠️ Context ${pct}% used (${used}/${total}), consider /compact`).catch(() => {});
  } catch {
    /* best-effort */
  }
}

function describeTelegramSendError(err: unknown): string {
  if (err instanceof GrammyError) return err.description;
  if (err instanceof HttpError) return String(err);
  if (err instanceof Error) return err.message;
  return String(err);
}

function isMessageNotModifiedError(err: unknown): boolean {
  const text = describeTelegramSendError(err).toLowerCase();
  return text.includes("message is not modified");
}

function isTextMustBeNonEmptyError(err: unknown): boolean {
  const text = describeTelegramSendError(err).toLowerCase();
  return text.includes("text must be non-empty");
}

function isDraftHtmlParseError(err: unknown): boolean {
  const text = describeTelegramSendError(err).toLowerCase();
  return text.includes("can't parse entities")
    || text.includes("cant parse entities")
    || text.includes("unsupported start tag")
    || text.includes("unexpected end tag")
    || text.includes("can't find end tag");
}

function isSendMessageDraftUnsupportedError(err: unknown): boolean {
  const text = describeTelegramSendError(err).toLowerCase();
  if (text.includes("sendmessagedraft")) return true;
  if (text.includes("method not found")) return true;
  if (text.includes("not implemented")) return true;
  return false;
}

interface DedupedImageGroups {
  current: LoadedImage[];
  referenced: LoadedImage[];
  all: LoadedImage[];
}

function ensureImageHash(img: LoadedImage): string | undefined {
  if (img.contentHash) return img.contentHash;
  if (!img.image) return undefined;
  img.contentHash = createHash("sha256").update(img.image.data).digest("hex");
  return img.contentHash;
}

function dedupeLoadedImageGroups(
  currentImages: LoadedImage[],
  referencedImages: LoadedImage[],
): DedupedImageGroups {
  const seenFileIds = new Set<string>();
  const seenHashes = new Set<string>();

  const current: LoadedImage[] = [];
  const referenced: LoadedImage[] = [];
  const all: LoadedImage[] = [];

  const push = (bucket: LoadedImage[], img: LoadedImage) => {
    const fid = String(img.fileId || "").toLowerCase();
    const hash = ensureImageHash(img);

    if (fid && seenFileIds.has(fid)) return;
    if (hash && seenHashes.has(hash)) return;

    if (fid) seenFileIds.add(fid);
    if (hash) seenHashes.add(hash);
    bucket.push(img);
    all.push(img);
  };

  for (const img of currentImages) push(current, img);
  for (const img of referencedImages) push(referenced, img);

  return { current, referenced, all };
}

function toPromptPathList(images: LoadedImage[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];

  for (const img of images) {
    const p = normalizePromptPath(img.localPath);
    const key = p.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(p);
  }

  return out;
}

function normalizePromptPathList(paths: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];

  for (const pRaw of paths) {
    const p = normalizePromptPath(String(pRaw || "").trim());
    if (!p) continue;
    const key = p.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(p);
  }

  return out;
}

function parseModelImageSupport(model: any): boolean | undefined {
  if (!model || typeof model !== "object") return undefined;

  if (Array.isArray(model.input)) {
    return model.input.includes("image");
  }

  if (typeof model.supportsImages === "boolean") return model.supportsImages;
  if (typeof model.supportsVision === "boolean") return model.supportsVision;
  if (typeof model.vision === "boolean") return model.vision;
  if (typeof model.imageInput === "boolean") return model.imageInput;

  const caps = model.capabilities;
  if (caps && typeof caps === "object") {
    if (typeof caps.image === "boolean") return caps.image;
    if (typeof caps.images === "boolean") return caps.images;
    if (typeof caps.imageInput === "boolean") return caps.imageInput;
    if (typeof caps.vision === "boolean") return caps.vision;
  }

  return undefined;
}

interface StreamUpdater {
  onTextDelta: (delta: string, fullText: string) => void;
  onToolStart: (toolName?: string) => void;
  onToolError: (toolName?: string) => void;
  stopAndWait: () => Promise<void>;
  dispose: () => void;
}

interface DraftPreviewRenderResult {
  draftText: string;
  getPlainText: () => string;
  parseMode?: "HTML";
  renderKey: string;
}

export interface DraftPreviewModel {
  onTextDelta: (delta: string, fullText: string) => void;
  onToolStart: (toolName?: string) => void;
  onToolError: () => void;
  render: (draftSupportsHtml?: boolean) => DraftPreviewRenderResult | null;
}

export function createDraftPreviewModel(maxLen: number): DraftPreviewModel {
  // Must stay within Bot API text limit (4096)
  const safeLimit = Math.min(Math.max(200, maxLen - 600), 3800);
  let text = "";
  const tools: string[] = [];
  let toolBlock = "";
  let lastPreview = "";
  let lastDraftSupportsHtml: boolean | undefined;
  let lastResult: DraftPreviewRenderResult | null = null;

  return {
    onTextDelta: (_delta, fullText) => {
      text = stripProtocolTags(fullText);
    },
    onToolStart: (toolName) => {
      if (toolName) tools.push(`🔧 ${toolName}`);
      toolBlock = tools.length ? `${tools.join("\n")}\n\n` : "";
    },
    onToolError: () => {
      if (tools.length > 0) {
        tools[tools.length - 1] = `${tools[tools.length - 1]} ❌`;
      } else {
        tools.push("🔧 Execution failed ❌");
      }
      toolBlock = tools.length ? `${tools.join("\n")}\n\n` : "";
    },
    render: (draftSupportsHtml = true) => {
      const preview = buildStreamingPreviewWithToolBlock(text, toolBlock, safeLimit);
      if (!preview) {
        lastPreview = "";
        lastDraftSupportsHtml = draftSupportsHtml;
        lastResult = null;
        return null;
      }
      if (preview === lastPreview && draftSupportsHtml === lastDraftSupportsHtml) {
        return lastResult;
      }

      let plainText: string | undefined;
      const getPlainText = () => {
        if (plainText !== undefined) return plainText;
        plainText = mdToPlainText(preview).trim();
        if (!plainText || plainText === "(no reply)") {
          plainText = "";
          return plainText;
        }
        if (plainText.length > 4096) {
          plainText = `${plainText.slice(0, 4095)}…`;
        }
        return plainText;
      };

      if (draftSupportsHtml) {
        const htmlDraftText = mdToTgHtml(preview).trim();
        if (htmlDraftText && htmlDraftText !== "(no reply)") {
          lastPreview = preview;
          lastDraftSupportsHtml = draftSupportsHtml;
          lastResult = {
            draftText: htmlDraftText,
            getPlainText,
            parseMode: "HTML",
            renderKey: `HTML:${htmlDraftText}`,
          };
          return lastResult;
        }
      }

      const draftText = getPlainText();
      if (!draftText) {
        lastPreview = preview;
        lastDraftSupportsHtml = draftSupportsHtml;
        lastResult = null;
        return null;
      }

      lastPreview = preview;
      lastDraftSupportsHtml = draftSupportsHtml;
      lastResult = {
        draftText,
        getPlainText,
        renderKey: `plain:${draftText}`,
      };
      return lastResult;
    },
  };
}

async function callSendMessageDraft(
  api: BotContext["api"],
  chatId: number,
  draftId: number,
  text: string,
  messageThreadId?: number,
  parseMode?: "HTML",
): Promise<void> {
  const other: Record<string, unknown> = {};
  if (Number.isSafeInteger(messageThreadId) && (messageThreadId as number) > 0) {
    other.message_thread_id = messageThreadId as number;
  }
  if (parseMode) {
    other.parse_mode = parseMode;
  }
  const sendOther = Object.keys(other).length > 0 ? other : undefined;

  const apiAny = api as any;

  if (typeof apiAny.sendMessageDraft === "function") {
    await apiAny.sendMessageDraft(chatId, draftId, text, sendOther);
    return;
  }

  if (typeof apiAny?.raw?.sendMessageDraft === "function") {
    await apiAny.raw.sendMessageDraft({
      chat_id: chatId,
      draft_id: draftId,
      text,
      ...(sendOther ?? {}),
    });
    return;
  }

  throw new Error("sendMessageDraft not supported by current grammY version");
}

function createDraftStreamUpdater(
  api: BotContext["api"],
  chatId: number,
  draftId: number,
  messageThreadId: number | undefined,
  maxLen: number,
  onDraftFallback?: (err: unknown) => void,
): StreamUpdater {
  const minEditIntervalMs = 700;
  const previewModel = createDraftPreviewModel(maxLen);
  let lastRendered = "";
  let lastEditAt = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let disposed = false;
  let disabled = false;
  let draftSupportsHtml = true;
  let pendingEdit: Promise<void> = Promise.resolve();

  const render = () => {
    if (disposed || disabled) return;

    const rendered = previewModel.render(draftSupportsHtml);
    if (!rendered) return;

    const { draftText, getPlainText, parseMode, renderKey } = rendered;
    if (renderKey === lastRendered) return;

    lastRendered = renderKey;
    lastEditAt = Date.now();

    pendingEdit = pendingEdit
      .then(async () => {
        if (disposed || disabled) return;
        try {
          await callSendMessageDraft(api, chatId, draftId, draftText, messageThreadId, parseMode);
        } catch (err) {
          let sendErr: unknown = err;

          if (parseMode === "HTML" && isDraftHtmlParseError(sendErr)) {
            draftSupportsHtml = false;
            try {
              const plainText = getPlainText();
              await callSendMessageDraft(api, chatId, draftId, plainText, messageThreadId);
              lastRendered = `plain:${plainText}`;
              return;
            } catch (fallbackErr) {
              sendErr = fallbackErr;
            }
          }

          if (isMessageNotModifiedError(sendErr)) return;
          if (isTextMustBeNonEmptyError(sendErr)) return;
          if (isSendMessageDraftUnsupportedError(sendErr)) {
            disabled = true;
          }
          try { onDraftFallback?.(sendErr); } catch { /* ignore callback error */ }
        }
      })
      .catch(() => {
        // keep chain alive
      });
  };

  const scheduleRender = () => {
    if (disposed || disabled) return;
    const wait = minEditIntervalMs - (Date.now() - lastEditAt);
    if (wait <= 0) {
      render();
      return;
    }
    if (!timer) {
      timer = setTimeout(() => {
        timer = null;
        render();
      }, wait);
    }
  };

  const dispose = () => {
    disposed = true;
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
  };

  return {
    onTextDelta: (delta, fullText) => {
      previewModel.onTextDelta(delta, fullText);
      scheduleRender();
    },
    onToolStart: (toolName) => {
      previewModel.onToolStart(toolName);
      scheduleRender();
    },
    onToolError: () => {
      previewModel.onToolError();
      scheduleRender();
    },
    stopAndWait: async () => {
      dispose();
      await pendingEdit.catch(() => {
        // ignore
      });
    },
    dispose,
  };
}

function createSilentStreamUpdater(): StreamUpdater {
  return {
    onTextDelta: () => {},
    onToolStart: () => {},
    onToolError: () => {},
    stopAndWait: async () => {},
    dispose: () => {},
  };
}

export function stripProtocolTags(text: string): string {
  let out = text;

  // Normal tags.
  out = out.replace(/<\/?\s*tg-(?:attachment|reply|cron)\b[^>]*>/gi, "");

  // Dangling/incomplete start tags.
  out = out.replace(/<\s*tg-(?:attachment|reply|cron)\b[^\r\n>]*/gi, "");

  // HTML-escaped tags.
  out = out.replace(/&lt;\/?\s*tg-(?:attachment|reply|cron)\b[\s\S]*?&gt;/gi, "");

  return out;
}

function buildStreamingPreviewWithToolBlock(text: string, toolBlock: string, limit: number): string {
  const available = Math.max(32, limit - toolBlock.length);

  if (!text) return toolBlock.trim();
  if (text.length <= available) return `${toolBlock}${text}`;

  const tail = text.slice(-available);
  return `${toolBlock}…${tail}`;
}

export function buildStreamingPreview(text: string, tools: string[], limit: number): string {
  const toolBlock = tools.length ? `${tools.join("\n")}\n\n` : "";
  return buildStreamingPreviewWithToolBlock(text, toolBlock, limit);
}

function splitMessage(text: string, limit: number): string[] {
  if (text.length <= limit) return [text];
  const parts: string[] = [];
  let rest = text;
  while (rest.length > 0) {
    if (rest.length <= limit) { parts.push(rest); break; }
    let at = rest.lastIndexOf("\n", limit);
    if (at < limit * 0.3) at = limit;
    parts.push(rest.slice(0, at));
    rest = rest.slice(at);
  }
  return parts;
}

interface PreparedReply {
  body: string;
  attachments: TgAttachment[];
  warnings: string[];
  replyParameters?: ReplyParameters;
}

interface CronPreparedReply {
  body: string;
  attachments: TgAttachment[];
  warnings: string[];
}

function prepareCronReply(text: string, tools: string[]): CronPreparedReply {
  const extractedReply = extractTgReplyDirective(text || "");
  const extracted = extractTgAttachments(extractedReply.text);
  let body = stripProtocolTags(extracted.text);

  if (tools.length) {
    body = `${tools.join("\n")}${body ? `\n\n${body}` : ""}`;
  }

  if (!body.trim() && extracted.attachments.length === 0) {
    body = "(no reply)";
  }

  return {
    body,
    attachments: extracted.attachments,
    warnings: [...extractedReply.warnings, ...extracted.warnings],
  };
}

function prepareReply(
  tgCtx: BotContext,
  text: string,
  tools: string[],
  extraWarnings: string[] = [],
): PreparedReply {
  const extractedReply = extractTgReplyDirective(text || "");
  const extracted = extractTgAttachments(extractedReply.text);
  const resolvedReply = resolveReplyParameters(replyScopeKey(tgCtx), extractedReply.directive);
  let body = stripProtocolTags(extracted.text);

  if (tools.length) {
    body = `${tools.join("\n")}${body ? `\n\n${body}` : ""}`;
  }

  if (!body.trim() && extracted.attachments.length === 0) {
    body = "(no reply)";
  }

  return {
    body,
    attachments: extracted.attachments,
    warnings: [...extractedReply.warnings, ...extracted.warnings, ...resolvedReply.warnings, ...extraWarnings],
    replyParameters: resolvedReply.replyParameters,
  };
}

async function sendPreparedReply(
  tgCtx: BotContext,
  prepared: PreparedReply,
  maxLen: number,
): Promise<void> {
  let first = true;
  if (prepared.body.trim()) {
    for (const part of splitMessage(prepared.body, maxLen)) {
      const html = mdToTgHtml(part);
      const opts = first && prepared.replyParameters
        ? { reply_parameters: prepared.replyParameters }
        : undefined;
      try {
        const sent = await tgCtx.reply(html, { parse_mode: "HTML", ...(opts ?? {}) });
        rememberReplyMessage(replyScopeKey(tgCtx), "self", sent.message_id, part);
      } catch (err) {
        log.warn(`chat${tgCtx.chat?.id ?? 0} HTML send failed, falling back to plain text: ${describeTelegramSendError(err)}`);
        const safePart = stripProtocolTags(part);
        const plain = mdToPlainText(safePart);
        const sent = await tgCtx.reply(plain, opts);
        rememberReplyMessage(replyScopeKey(tgCtx), "self", sent.message_id, plain);
      }
      first = false;
    }
  }

  await sendAttachments(
    tgCtx,
    prepared.attachments,
    prepared.warnings,
    first ? prepared.replyParameters : undefined,
  );
}

async function sendAttachments(
  tgCtx: BotContext,
  attachments: TgAttachment[],
  warnings: string[],
  replyParameters?: ReplyParameters,
): Promise<void> {
  if (warnings.length) {
    const preview = warnings.slice(0, 3).join("\n");
    const more = warnings.length > 3 ? `\n... and ${warnings.length - 3} items in queue` : "";
    await tgCtx.reply(`⚠️ Attachment parse warnings: \n${preview}${more}`).catch(() => {});
  }

  let first = true;
  for (const att of attachments) {
    try {
      const opts = first && replyParameters
        ? { reply_parameters: replyParameters }
        : undefined;
      await sendOneAttachment(tgCtx, att, opts);
    } catch (err) {
      await tgCtx.reply(`❌ Attachment send failed: ${att.label || "Unknown attachment"}\n${(err as Error).message}`).catch(() => {});
    }
    first = false;
  }
}

type ReplyMethodName =
  | "replyWithPhoto"
  | "replyWithDocument"
  | "replyWithVideo"
  | "replyWithAudio"
  | "replyWithAnimation"
  | "replyWithVoice"
  | "replyWithVideoNote"
  | "replyWithSticker";

type MediaInput = TgAttachment["media"];
type SendOther = { reply_parameters?: ReplyParameters };

const REPLY_BY_KIND: Record<TgAttachmentKind, ReplyMethodName> = {
  photo: "replyWithPhoto",
  document: "replyWithDocument",
  video: "replyWithVideo",
  audio: "replyWithAudio",
  animation: "replyWithAnimation",
  voice: "replyWithVoice",
  video_note: "replyWithVideoNote",
  sticker: "replyWithSticker",
};

const REPLY_SENDER: Record<ReplyMethodName, (ctx: BotContext, media: MediaInput, other?: SendOther) => Promise<unknown>> = {
  replyWithPhoto: (ctx, media, other) => ctx.replyWithPhoto(media, other),
  replyWithDocument: (ctx, media, other) => ctx.replyWithDocument(media, other),
  replyWithVideo: (ctx, media, other) => ctx.replyWithVideo(media, other),
  replyWithAudio: (ctx, media, other) => ctx.replyWithAudio(media, other),
  replyWithAnimation: (ctx, media, other) => ctx.replyWithAnimation(media, other),
  replyWithVoice: (ctx, media, other) => ctx.replyWithVoice(media, other),
  replyWithVideoNote: (ctx, media, other) => ctx.replyWithVideoNote(media, other),
  replyWithSticker: (ctx, media, other) => ctx.replyWithSticker(media, other),
};

async function sendOneAttachment(
  tgCtx: BotContext,
  att: TgAttachment,
  other?: SendOther,
): Promise<void> {
  const method = REPLY_BY_KIND[att.kind] || "replyWithDocument";

  try {
    await REPLY_SENDER[method](tgCtx, att.media, other);
  } catch (err) {
    if (method === "replyWithDocument") throw err;
    await REPLY_SENDER.replyWithDocument(tgCtx, att.media, other);
  }
}

async function sendReply(
  tgCtx: BotContext,
  text: string,
  tools: string[],
  maxLen: number,
  extraWarnings: string[] = [],
): Promise<void> {
  const prepared = prepareReply(tgCtx, text, tools, extraWarnings);
  await sendPreparedReply(tgCtx, prepared, maxLen);
}

const CRON_HELP_TEXT = [
  "⏰ /cron usage",
  "- /cron (open interactive menu)",
  "- /cron list",
  "- /cron stat",
  "- /cron add at <ISO-time> <content> (use name||content to set job name)",
  "- /cron add every <interval> <content> (e.g. 10m, 2h, 1d; use name||content)",
  "- /cron add cron \"<expression>\" [timezone] <content> (use name||content)",
  "- /cron on <id>",
  "- /cron off <id>",
  "- /cron del <id>",
  "- /cron rename <id> <new name>",
  "- /cron run <id>",
].join("\n");

function extractCommandArgs(text: string, command: string): string {
  const re = new RegExp(`^\\/${command}(?:@\\w+)?\\s*`, "i");
  return text.replace(re, "").trim();
}

function splitCommandArgs(input: string): string[] {
  if (!input.trim()) return [];
  const out: string[] = [];
  const re = /"([^"\\]*(?:\\.[^"\\]*)*)"|'([^'\\]*(?:\\.[^'\\]*)*)'|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(input)) !== null) {
    const token = m[1] ?? m[2] ?? m[3] ?? "";
    out.push(token.replace(/\\(["'\\])/g, "$1"));
  }
  return out;
}

function parseNamedPrompt(input: string): { name?: string; prompt: string } {
  const raw = String(input || "").trim();
  if (!raw) return { prompt: "" };

  const sep = raw.indexOf("||");
  if (sep < 0) {
    return { prompt: raw };
  }

  const left = raw.slice(0, sep).trim();
  const right = raw.slice(sep + 2).trim();
  if (!right) {
    return { prompt: raw };
  }

  return {
    name: left || undefined,
    prompt: right,
  };
}

function parseDurationMs(input: string): number | undefined {
  const s = String(input || "").trim().toLowerCase();
  if (!s) return undefined;

  const re = /(\d+)\s*(d|h|m|s)/g;
  let total = 0;
  let matched = "";
  let m: RegExpExecArray | null;

  while ((m = re.exec(s)) !== null) {
    const n = Number.parseInt(m[1], 10);
    if (!Number.isFinite(n) || n < 0) return undefined;

    switch (m[2]) {
      case "d": total += n * 24 * 60 * 60 * 1000; break;
      case "h": total += n * 60 * 60 * 1000; break;
      case "m": total += n * 60 * 1000; break;
      case "s": total += n * 1000; break;
      default: return undefined;
    }

    matched += m[0];
  }

  const compactInput = s.replace(/\s+/g, "");
  const compactMatched = matched.replace(/\s+/g, "");
  if (!compactMatched || compactMatched !== compactInput) return undefined;
  if (total < 1000) return undefined;
  return total;
}

function looksLikeTimezone(input: string): boolean {
  const s = String(input || "").trim();
  if (!s) return false;
  if (s === "UTC" || s === "GMT") return true;
  if (/^(UTC|GMT)[+-]\d{1,2}$/.test(s)) return true;
  return /^[A-Za-z_]+\/[A-Za-z0-9_+-]+(?:\/[A-Za-z0-9_+-]+)?$/.test(s);
}

function formatDateTime(ms?: number): string {
  if (!ms || ms <= 0) return "-";
  return new Date(ms).toLocaleString("zh-CN", { hour12: false });
}

function formatCompactDuration(ms: number): string {
  const totalSec = Math.max(1, Math.floor(ms / 1000));
  const days = Math.floor(totalSec / 86400);
  const hours = Math.floor((totalSec % 86400) / 3600);
  const mins = Math.floor((totalSec % 3600) / 60);
  const secs = totalSec % 60;

  const parts: string[] = [];
  if (days) parts.push(`${days}d`);
  if (hours) parts.push(`${hours}h`);
  if (mins) parts.push(`${mins}m`);
  if (secs || !parts.length) parts.push(`${secs}s`);
  return parts.join("");
}

function formatCronSchedule(schedule: CronSchedule): string {
  switch (schedule.kind) {
    case "at":
      return `at ${formatDateTime(schedule.atMs)}`;
    case "every":
      return `every ${formatCompactDuration(schedule.everyMs)}（anchor=${formatDateTime(schedule.anchorMs)})`;
    case "cron":
      return `cron "${schedule.expr}" @${schedule.timezone}`;
    default:
      return "unknown";
  }
}

function formatCronJobLine(job: CronJobRecord): string {
  const status = job.enabled ? "🟢" : "⚪";
  const running = job.state.runningRunId ? " ⏳running" : "";
  const lastStatus = job.state.lastStatus ? ` | last=${job.state.lastStatus}` : "";
  const lastErr = job.state.lastError ? ` | err=${truncate(job.state.lastError, 40)}` : "";

  return [
    `${status} ${job.id}${running}`,
    `  ${truncate(job.name, 70)}`,
    `  ${formatCronSchedule(job.schedule)}`,
    `  next=${formatDateTime(job.state.nextRunAtMs)}${lastStatus}${lastErr}`,
  ].join("\n");
}

function formatCronStatus(st: { enabled: boolean; totalJobs: number; enabledJobs: number; runningJobs: number; queuedJobs: number; nextRunAtMs?: number }): string {
  return [
    `⏰ Cron service: ${st.enabled ? "On" : "Off"}`,
    `Total tasks: ${st.totalJobs}`,
    `Enabled: ${st.enabledJobs}`,
    `Running: ${st.runningJobs}`,
    `Queued: ${st.queuedJobs}`,
    `Next trigger: ${formatDateTime(st.nextRunAtMs)}`,
  ].join("\n");
}
