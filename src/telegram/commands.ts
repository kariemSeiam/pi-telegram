// src/telegram/commands.ts — /command registrations using shared bot state
import { InputFile } from "grammy";
import { CommandGroup } from "@grammyjs/commands";
import type { BotContext, SharedBotState, ActivePromptMode } from "./bot-context.js";
import type { PiSessionStats } from "../pi/types.js";
import { buildStatusLines } from "./status.js";
import {
  chatKey,
  replyScopeKey,
  truncate,
  extractCommandArgs,
} from "./utils.js";
import { rememberReplyMessage } from "./reply.js";

const ABORT_NOTICE_SUPPRESS_TTL_MS = 15_000;

export function suppressAbortNotice(shared: SharedBotState, chatId: number, count = 1): void {
  if (!Number.isSafeInteger(chatId) || count <= 0) return;
  const now = Date.now();
  const list = (shared.abortNoticeSuppressionByChat.get(chatId) ?? []).filter((e) => e > now);
  const expiresAt = now + ABORT_NOTICE_SUPPRESS_TTL_MS;
  for (let i = 0; i < count; i += 1) list.push(expiresAt);
  shared.abortNoticeSuppressionByChat.set(chatId, list);
}

export function consumeAbortNoticeSuppression(shared: SharedBotState, chatId: number): boolean {
  const now = Date.now();
  const list = shared.abortNoticeSuppressionByChat.get(chatId);
  if (!list?.length) return false;
  const alive = list.filter((e) => e > now);
  if (!alive.length) { shared.abortNoticeSuppressionByChat.delete(chatId); return false; }
  alive.shift();
  if (alive.length) shared.abortNoticeSuppressionByChat.set(chatId, alive);
  else shared.abortNoticeSuppressionByChat.delete(chatId);
  return true;
}

export function createActivePromptTracker(shared: SharedBotState, chatId: number, mode: ActivePromptMode) {
  const token = Symbol(`prompt:${chatId}:${mode}`);
  let started = false;
  let finished = false;
  let resolveDone: () => void = () => {};
  const done = new Promise<void>((resolve) => { resolveDone = resolve; });

  return {
    token,
    onStart: () => {
      if (started) return;
      started = true;
      shared.activePromptByChat.set(chatId, { token, mode, done });
    },
    finish: () => {
      if (finished) return;
      finished = true;
      const current = shared.activePromptByChat.get(chatId);
      if (current?.token === token) shared.activePromptByChat.delete(chatId);
      shared.abortDirectiveByPromptToken.delete(token);
      resolveDone();
    },
    done,
  };
}

export function cancelQueuedSilently(
  shared: SharedBotState,
  chatId: number,
  inst: ReturnType<import("../pi/pool.js").PiPool["has"]>,
): number {
  if (!inst?.alive) return 0;
  const queued = inst.queuedCount;
  if (queued > 0) {
    suppressAbortNotice(shared, chatId, queued);
    inst.cancelQueued();
  }
  return queued;
}

export async function abortActivePrompt(
  shared: SharedBotState,
  chatId: number,
  inst: ReturnType<import("../pi/pool.js").PiPool["has"]>,
  opts: { sendPartial: boolean; showAbortNotice: boolean },
): Promise<{ aborted: boolean; mode?: ActivePromptMode }> {
  const active = shared.activePromptByChat.get(chatId);
  if (!active || !inst?.alive) return { aborted: false };
  shared.abortDirectiveByPromptToken.set(active.token, {
    sendPartial: opts.sendPartial,
    showAbortNotice: opts.showAbortNotice,
  });
  inst.abort();
  await active.done;
  return { aborted: true, mode: active.mode };
}

export function registerCommands(shared: SharedBotState): CommandGroup<BotContext> {
  const { botKey, pool, cron, menus } = shared;
  const commandGroup = new CommandGroup<BotContext>();

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
        if (typeof m?.reasoning === "boolean") thinkingSupported = m.reasoning;
        if (thinkingSupported && st.thinkingLevel) thinkingLabel = String(st.thinkingLevel);
        if (st.sessionId) sessionLabel = String(st.sessionId).slice(0, 8);
      } catch { /* ignore */ }
      try {
        const stats = await inst.getSessionStats();
        if (typeof stats.cost === "number" && stats.cost > 0) cost = stats.cost;
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
      cancelQueuedSilently(shared, chatId, inst);
      await abortActivePrompt(shared, chatId, inst, { sendPartial: true, showAbortNotice: true });
    }
    try {
      await pool.getFresh(key);
      await tgCtx.reply("🆕 New session created");
    } catch (err) {
      await tgCtx.reply(`❌ Failed to create session: ${truncate((err as Error).message, 1000)}`);
    }
  });

  commandGroup.command("kill", "Kill current operation", async (tgCtx) => {
    const chatId = tgCtx.chat.id;
    const key = chatKey(botKey, chatId);
    const inst = pool.has(key);
    if (!inst?.alive) { await tgCtx.reply("No active operation"); return; }
    const queued = inst.queuedCount;
    const stopped = await abortActivePrompt(shared, chatId, inst, { sendPartial: true, showAbortNotice: true });
    if (stopped.aborted) {
      if (queued > 0) await tgCtx.reply(`📥 Queue retained ${queued} items, continuing\nUse /killall to clear the queue`);
      return;
    }
    if (queued > 0) { await tgCtx.reply(`No running task, ${queued} items in queue`); return; }
    await tgCtx.reply("No active operation");
  });

  commandGroup.command("killall", "Kill and clear queue", async (tgCtx) => {
    const chatId = tgCtx.chat.id;
    const key = chatKey(botKey, chatId);
    const inst = pool.has(key);
    if (!inst?.alive || (!inst.running && inst.queuedCount === 0)) {
      await tgCtx.reply("No active operation"); return;
    }
    const cleared = cancelQueuedSilently(shared, chatId, inst);
    const stopped = await abortActivePrompt(shared, chatId, inst, { sendPartial: true, showAbortNotice: true });
    if (cleared > 0) { await tgCtx.reply(`🧹 Cleared ${cleared} items in queue`); return; }
    if (!stopped.aborted) await tgCtx.reply("No running task");
  });

  commandGroup.command("compact", "Compact context", async (tgCtx) => {
    const chatId = tgCtx.chat.id;
    const key = chatKey(botKey, chatId);
    const inst = pool.has(key);
    if (!inst?.alive) { await tgCtx.reply("Session not started, send a message first"); return; }
    if (inst.streaming) { await tgCtx.reply("⏳ Currently generating, /kill first"); return; }
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
    if (!inst?.alive) { await tgCtx.reply("Session not started"); return; }
    if (!inst.streaming) { await tgCtx.reply("No running task"); return; }
    const text = extractCommandArgs(String(tgCtx.message?.text || ""), "steer");
    if (!text.trim()) { await tgCtx.reply("Usage: /steer <message>"); return; }
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
    if (!inst?.alive) { await tgCtx.reply("Session not started"); return; }
    if (inst.streaming) { await tgCtx.reply("⏳ Wait for current task to finish before exporting"); return; }
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
    if (!inst?.alive) { await tgCtx.reply("Session not started"); return; }
    if (inst.streaming) { await tgCtx.reply("⏳ Wait for current task to finish before forking"); return; }
    const status = await tgCtx.reply("⏳ Fetching forkable messages...");
    try {
      const messages = await inst.getForkMessages();
      await status.delete().catch(() => {});
      if (!messages.length) { await tgCtx.reply("No forkable messages"); return; }
      const recent = messages.slice(-10);
      const lines = recent.map((m, i) => {
        const preview = truncate(m.text, 80).replace(/\n/g, " ");
        return `${i + 1}. ${preview}`;
      });
      lines.push("", "Reply to this message with the number to fork, e.g.: 3");
      await tgCtx.reply(`📋 Forkable messages (latest ${recent.length} items in queue)：\n${lines.join("\n")}`);
      shared.pendingForkMessages.set(chatId, recent);
    } catch (err) {
      await status.delete().catch(() => {});
      await tgCtx.reply(`❌ Fetch failed: ${truncate((err as Error).message, 500)}`);
    }
  });

  commandGroup.command("undo", "Undo and regenerate", async (tgCtx) => {
    const chatId = tgCtx.chat.id;
    const key = chatKey(botKey, chatId);
    const inst = pool.has(key);
    if (!inst?.alive) { await tgCtx.reply("Session not started"); return; }
    if (inst.streaming) { await tgCtx.reply("⏳ Wait for current task to finish"); return; }
    try {
      const lastText = await inst.getLastAssistantText();
      if (!lastText) { await tgCtx.reply("No replies to undo"); return; }
      const preview = truncate(lastText, 120);
      await tgCtx.reply(`Undoed: "${preview}..."\nSend new instructions or corrections.`);
      rememberReplyMessage(replyScopeKey(tgCtx), "self", tgCtx.message!.message_id, lastText);
    } catch (err) {
      await tgCtx.reply(`❌ Fetch failed: ${truncate((err as Error).message, 500)}`);
    }
  });

  commandGroup.command("model", "Switch model", async (tgCtx) => {
    const chatId = tgCtx.chat.id;
    try { await menus.refreshModelsForChat(chatId); } catch (err) {
      await tgCtx.reply(`❌ Failed to get model list: ${(err as Error).message}`); return;
    }
    await tgCtx.reply("🔄 Select Provider:", { reply_markup: shared.menus.modelMenu });
  });

  commandGroup.command("stream", "Toggle streaming output", async (tgCtx) => {
    await tgCtx.reply("⚙️ Output mode:", { reply_markup: shared.menus.streamMenu });
  });

  commandGroup.command("thinking", "Switch thinking level", async (tgCtx) => {
    const chatId = tgCtx.chat.id;
    const supported = await menus.supportsThinkingForChat(chatId);
    if (!supported) { await tgCtx.reply("Current model does not support thinking levels"); return; }
    await menus.ensureThinkingForChat(chatId);
    await tgCtx.reply("🧠 Thinking level:", { reply_markup: shared.menus.thinkingMenu });
  });

  return commandGroup;
}
