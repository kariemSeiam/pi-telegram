import type { PiSessionStats } from "../pi/types.js";

interface CronStatusSummary {
  enabled: boolean;
  totalJobs: number;
  enabledJobs: number;
}

export interface BotStatusSnapshot {
  alive: boolean;
  processing: boolean;
  providerLabel?: string;
  modelLabel: string;
  streamEnabled: boolean;
  thinkingLabel?: string;
  sessionLabel?: string;
  cost?: number;
  contextUsage?: PiSessionStats["contextUsage"];
  activeCount: number;
  cron: CronStatusSummary;
}

function formatInteger(value: number): string {
  return new Intl.NumberFormat("en-US").format(value);
}

export function formatCost(cost: number): string {
  if (cost >= 1) return cost.toFixed(2);
  if (cost >= 0.01) return cost.toFixed(3);
  if (cost >= 0.001) return cost.toFixed(4);
  return cost.toPrecision(2);
}

export function formatContextUsage(
  usage?: PiSessionStats["contextUsage"],
): string | undefined {
  if (!usage || typeof usage.contextWindow !== "number") return undefined;

  const used = typeof usage.tokens === "number" ? formatInteger(usage.tokens) : "?";
  const total = formatInteger(usage.contextWindow);
  const percent = typeof usage.percent === "number"
    ? ` (${usage.percent.toFixed(usage.percent >= 10 || Number.isInteger(usage.percent) ? 0 : 1)}%)`
    : "";

  return `📦 Context usage: ${used} / ${total}${percent}`;
}

export function buildStatusLines(snapshot: BotStatusSnapshot): string[] {
  const lines: Array<string | undefined> = [
    `${snapshot.alive ? "✅ Running" : "💤 Not started"} | ${snapshot.processing ? "⏳ Processing" : "🟢 Idle"}`,
    snapshot.providerLabel ? `🏢 Provider: ${snapshot.providerLabel}` : undefined,
    `🤖 Model: ${snapshot.modelLabel}`,
    `⚙️ Output: ${snapshot.streamEnabled ? "Streaming" : "Non-streaming"}`,
    snapshot.thinkingLabel ? `🧠 Thinking: ${snapshot.thinkingLabel}` : undefined,
    snapshot.sessionLabel ? `🗂 Session: ${snapshot.sessionLabel}` : undefined,
    typeof snapshot.cost === "number" && snapshot.cost > 0 ? `💰 Cost: $${formatCost(snapshot.cost)}` : undefined,
    formatContextUsage(snapshot.contextUsage),
    `📊 Active: ${snapshot.activeCount}`,
    `⏰ Cron: ${snapshot.cron.enabled ? "Enabled" : "Disabled"} | Jobs ${snapshot.cron.totalJobs} (Enabled ${snapshot.cron.enabledJobs})`,
  ];

  return lines.filter((line): line is string => Boolean(line));
}
