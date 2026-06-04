// src/telegram/utils.ts — pure utility functions, no state
import { GrammyError, HttpError } from "grammy";
import type { BotContext } from "./bot-context.js";
import type { CronJobRecord, CronSchedule } from "../cron/types.js";

// --- chat key helpers ---

export function chatKey(botKey: string, chatId: number): string {
  return `bot${botKey}_chat${chatId}`;
}

export function replyScopeKey(tgCtx: BotContext): string {
  return `${tgCtx.me.id}:${tgCtx.chat?.id ?? 0}`;
}

// --- message extraction ---

export function extractMessageText(msg: any): string {
  if (!msg) return "";
  const text = String(msg.text || "").trim();
  const caption = String(msg.caption || "").trim();
  if (text && caption) return `${text}\n${caption}`;
  return text || caption;
}

export function formatMessageSender(msg: any, meId: number): string {
  if (!msg) return "";
  if (msg.from?.id === meId) return "self";
  if (msg.from?.username) return `@${msg.from.username}`;
  if (msg.from?.first_name) return msg.from.first_name;
  if (msg.sender_chat?.title) return msg.sender_chat.title;
  return "user";
}

export function truncate(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max)}…`;
}

export function normalizePromptPath(p: string): string {
  return p.replace(/\\/g, "/");
}

export function normalizePromptPathList(paths: string[]): string[] {
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

// --- telegram context helpers ---

export function getMessageThreadId(tgCtx: BotContext): number | undefined {
  const raw = Number((tgCtx.message as any)?.message_thread_id);
  if (!Number.isSafeInteger(raw) || raw <= 0) return undefined;
  return raw;
}

export function shouldUseDraftStreaming(tgCtx: BotContext): boolean {
  const chat = tgCtx.chat as any;
  if (!chat) return false;
  return chat.type === "private";
}

// --- command parsing ---

export function extractCommandArgs(text: string, command: string): string {
  const escaped = command.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`^\\/${escaped}(?:@\\w+)?\\s*`, "i");
  return text.replace(re, "").trim();
}

export function splitCommandArgs(input: string): string[] {
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

export function parseNamedPrompt(input: string): { name?: string; prompt: string } {
  const raw = String(input || "").trim();
  if (!raw) return { prompt: "" };
  const sep = raw.indexOf("||");
  if (sep < 0) return { prompt: raw };
  const left = raw.slice(0, sep).trim();
  const right = raw.slice(sep + 2).trim();
  if (!right) return { prompt: raw };
  return { name: left || undefined, prompt: right };
}

export function parseDurationMs(input: string): number | undefined {
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

export function looksLikeTimezone(input: string): boolean {
  const s = String(input || "").trim();
  if (!s) return false;
  if (s === "UTC" || s === "GMT") return true;
  if (/^(UTC|GMT)[+-]\d{1,2}$/.test(s)) return true;
  return /^[A-Za-z_]+\/[A-Za-z0-9_+-]+(?:\/[A-Za-z0-9_+-]+)?$/.test(s);
}

// --- formatting ---

export function formatDateTime(ms?: number): string {
  if (!ms || ms <= 0) return "-";
  return new Date(ms).toLocaleString("zh-CN", { hour12: false });
}

export function formatCompactDuration(ms: number): string {
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

export function formatCronSchedule(schedule: CronSchedule): string {
  switch (schedule.kind) {
    case "at": return `at ${formatDateTime(schedule.atMs)}`;
    case "every": return `every ${formatCompactDuration(schedule.everyMs)}（anchor=${formatDateTime(schedule.anchorMs)})`;
    case "cron": return `cron "${schedule.expr}" @${schedule.timezone}`;
    default: return "unknown";
  }
}

export function formatCronJobLine(job: CronJobRecord): string {
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

export function formatCronStatus(st: {
  enabled: boolean;
  totalJobs: number;
  enabledJobs: number;
  runningJobs: number;
  queuedJobs: number;
  nextRunAtMs?: number;
}): string {
  return [
    `⏰ Cron service: ${st.enabled ? "On" : "Off"}`,
    `Total tasks: ${st.totalJobs}`,
    `Enabled: ${st.enabledJobs}`,
    `Running: ${st.runningJobs}`,
    `Queued: ${st.queuedJobs}`,
    `Next trigger: ${formatDateTime(st.nextRunAtMs)}`,
  ].join("\n");
}

// --- error detection ---

export function describeTelegramSendError(err: unknown): string {
  if (err instanceof GrammyError) return err.description;
  if (err instanceof HttpError) return String(err);
  if (err instanceof Error) return err.message;
  return String(err);
}

export function isMessageNotModifiedError(err: unknown): boolean {
  return describeTelegramSendError(err).toLowerCase().includes("message is not modified");
}

export function isTextMustBeNonEmptyError(err: unknown): boolean {
  return describeTelegramSendError(err).toLowerCase().includes("text must be non-empty");
}

export function isDraftHtmlParseError(err: unknown): boolean {
  const text = describeTelegramSendError(err).toLowerCase();
  return text.includes("can't parse entities")
    || text.includes("cant parse entities")
    || text.includes("unsupported start tag")
    || text.includes("unexpected end tag")
    || text.includes("can't find end tag");
}

export function isSendMessageDraftUnsupportedError(err: unknown): boolean {
  const text = describeTelegramSendError(err).toLowerCase();
  return text.includes("sendmessagedraft")
    || text.includes("method not found")
    || text.includes("not implemented");
}

// --- context warnings ---

export const CONTEXT_WARN_THRESHOLD = 0.85;

export async function maybeWarnContextFull(
  tgCtx: BotContext,
  inst: ReturnType<import("../pi/pool.js").PiPool["get"]>,
): Promise<void> {
  if (!inst?.alive) return;
  try {
    const stats = await inst.getSessionStats();
    const usage = stats?.contextUsage;
    if (!usage || typeof usage.percent !== "number" || usage.percent < CONTEXT_WARN_THRESHOLD) return;
    const pct = usage.percent.toFixed(0);
    const used = typeof usage.tokens === "number" ? usage.tokens : "?";
    const total = typeof usage.contextWindow === "number" ? usage.contextWindow : "?";
    await tgCtx.reply(`⚠️ Context ${pct}% used (${used}/${total}), consider /compact`).catch(() => {});
  } catch { /* best-effort */ }
}

export async function reportStatusOrReply(
  tgCtx: BotContext,
  status: { delete?: () => Promise<unknown>; editText: (text: string, other?: Record<string, unknown>) => Promise<unknown> },
  text: string,
): Promise<void> {
  const safe = truncate(text, 3500);
  await status.delete?.().catch(() => {});
  await tgCtx.reply(safe).catch(async () => {
    try { await status.editText(safe); } catch { /* ignore */ }
  });
}
