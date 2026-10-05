// src/telegram/cron-approval.ts — human approval for model-issued <tg-cron> changes
//
// A model can be steered by anything it reads, and a cron job re-runs its prompt with
// full agent powers forever. So a <tg-cron> directive that changes state (add/run/on/
// off/del/rename) is never executed straight from model output: it is parked here and
// the human taps Approve in the chat. Read-only actions (list/stat) skip this.
import { randomBytes } from "node:crypto";
import type { TgCronDirective } from "../cron/directives.js";

const TTL_MS = 5 * 60_000;
const MAX_PENDING_PER_CHAT = 8;

export interface PendingCron {
  token: string;
  chatId: number;
  userId: number;
  directive: TgCronDirective;
  createdAt: number;
}

const pending = new Map<string, PendingCron>();

export function needsApproval(d: TgCronDirective): boolean {
  return d.action !== "list" && d.action !== "stat";
}

function sweep(now = Date.now()): void {
  for (const [k, v] of pending) if (now - v.createdAt > TTL_MS) pending.delete(k);
}

export function park(chatId: number, userId: number, directive: TgCronDirective): PendingCron | undefined {
  sweep();
  const inChat = [...pending.values()].filter((p) => p.chatId === chatId).length;
  if (inChat >= MAX_PENDING_PER_CHAT) return undefined;
  const token = randomBytes(8).toString("hex"); // 64-bit, fits callback_data limit
  const p: PendingCron = { token, chatId, userId, directive, createdAt: Date.now() };
  pending.set(token, p);
  return p;
}

/** Consume exactly once; only the same user in the same chat can resolve it. */
export function take(token: string, chatId: number, userId: number): PendingCron | undefined {
  sweep();
  const p = pending.get(token);
  if (!p || p.chatId !== chatId || p.userId !== userId) return undefined;
  pending.delete(token);
  return p;
}

export function describe(d: TgCronDirective): string {
  switch (d.action) {
    case "add": {
      const when = d.kind === "at" ? `at ${d.at}` : d.kind === "every" ? `every ${d.every}` : `cron ${d.expr} ${d.timezone ?? ""}`.trim();
      return `➕ Create scheduled task (${when})\nName: ${d.name ?? "(auto)"}\nPrompt: ${String(d.prompt ?? "").slice(0, 400)}`;
    }
    case "run": return `▶️ Run task ${d.id} now`;
    case "on": return `✅ Enable task ${d.id}`;
    case "off": return `⏸ Disable task ${d.id}`;
    case "del": return `🗑 Delete task ${d.id}`;
    case "rename": return `✏️ Rename task ${d.id} → ${d.name}`;
    default: return String(d.action);
  }
}

export function _resetForTests(): void {
  pending.clear();
}
