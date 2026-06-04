// src/telegram/bot-context.ts — shared types and state for the modular bot
import type { Bot, Context } from "grammy";
import type { HydrateFlavor } from "@grammyjs/hydrate";
import type { AutoChatActionFlavor } from "@grammyjs/auto-chat-action";
import type { PiPool } from "../pi/pool.js";
import type { PiImage } from "../pi/types.js";
import type { CronService } from "../cron/service.js";
import type { CronSchedule } from "../cron/types.js";
import type { BotConfig } from "../shared/types.js";
import type { BotMenus as BotMenusGeneric } from "./menu.js";

export type BotContext = HydrateFlavor<Context> & AutoChatActionFlavor;

export type ActivePromptMode = "stream" | "non-stream";

export interface ActivePromptState {
  token: symbol;
  mode: ActivePromptMode;
  done: Promise<void>;
}

export interface AbortDirective {
  sendPartial: boolean;
  showAbortNotice: boolean;
}

export type CronPendingInput =
  | { kind: "at" | "every" | "cron"; startedAt: number }
  | { kind: "rename"; jobId: string; startedAt: number };

export interface LoadedImage {
  fileId: string;
  localPath: string;
  contentHash?: string;
  image?: PiImage;
}

export interface ReplyContextOptions {
  currentImagePaths?: string[];
  referencedImagePaths?: string[];
  currentFilePaths?: string[];
}

export type PromptPayload = { message: string; images?: PiImage[] };
export type PromptBuildOptions = { supportsImages: boolean };

export interface PreparedReply {
  body: string;
  attachments: import("./attachment.js").TgAttachment[];
  warnings: string[];
  replyParameters?: import("@grammyjs/types").ReplyParameters;
}

export interface CronPreparedReply {
  body: string;
  attachments: import("./attachment.js").TgAttachment[];
  warnings: string[];
}

export interface StreamUpdater {
  onTextDelta: (delta: string, fullText: string) => void;
  onToolStart: (toolName?: string) => void;
  onToolError: (toolName?: string) => void;
  stopAndWait: () => Promise<void>;
  dispose: () => void;
}

export interface DraftPreviewRenderResult {
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

export type BotMenus = BotMenusGeneric<BotContext>;

export interface SharedBotState {
  readonly botIndex: number;
  readonly botKey: string;
  readonly config: BotConfig;
  readonly pool: PiPool;
  readonly cron: CronService;
  readonly maxResponseLength: number;
  readonly bot: Bot<BotContext>;
  readonly menus: BotMenus;
  readonly onStreamModeChange?: (chatId: number, enabled: boolean) => Promise<void> | void;

  // Mutable state
  readonly activePromptByChat: Map<number, ActivePromptState>;
  readonly abortDirectiveByPromptToken: Map<symbol, AbortDirective>;
  readonly abortNoticeSuppressionByChat: Map<number, number[]>;
  readonly pendingForkMessages: Map<number, Array<{ entryId: string; text: string }>>;
  readonly cronPendingInput: Map<number, CronPendingInput>;
  readonly cronMenuPageByChat: Map<number, number>;
  readonly cronMenuMessageByChat: Map<number, number>;
  readonly imageSupportCache: Map<number, { value: boolean; at: number }>;
  readonly draftCounterByChat: Map<number, number>;
  cronScopeBotId: number | null;
}

export interface CreateBotOptions {
  botIndex: number;
  config: BotConfig;
  pool: PiPool;
  cron: CronService;
  maxResponseLength: number;
  initialStreamByChat?: Record<string, boolean>;
  onStreamModeChange?: (chatId: number, enabled: boolean) => Promise<void> | void;
}
