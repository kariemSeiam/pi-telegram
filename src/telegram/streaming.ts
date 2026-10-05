// src/telegram/streaming.ts — draft preview model and stream updaters
import type {
	BotContext,
	DraftPreviewModel,
	DraftPreviewRenderResult,
	StreamUpdater,
} from "./bot-context.js";
import { mdToPlainText, mdToTgHtml } from "./format.js";
import {
	isDraftHtmlParseError,
	isMessageNotModifiedError,
	isTextMustBeNonEmptyError,
	isSendMessageDraftUnsupportedError,
} from "./utils.js";

// --- protocol tag stripping ---

export function stripProtocolTags(text: string): string {
	let out = text;
	out = out.replace(/<\/?\s*tg-(?:attachment|reply|cron)\b[^>]*>/gi, "");
	out = out.replace(/<\s*tg-(?:attachment|reply|cron)\b[^\r\n>]*/gi, "");
	out = out.replace(
		/&lt;\/?\s*tg-(?:attachment|reply|cron)\b[\s\S]*?&gt;/gi,
		"",
	);
	return out;
}

// --- preview building ---

export function buildStreamingPreviewWithToolBlock(
	text: string,
	toolBlock: string,
	limit: number,
): string {
	const available = Math.max(32, limit - toolBlock.length);
	if (!text) return toolBlock.trim();
	if (text.length <= available) return `${toolBlock}${text}`;
	const tail = text.slice(-available);
	return `${toolBlock}…${tail}`;
}

export function buildStreamingPreview(
	text: string,
	tools: string[],
	limit: number,
): string {
	const toolBlock = tools.length ? `${tools.join("\n")}\n\n` : "";
	return buildStreamingPreviewWithToolBlock(text, toolBlock, limit);
}

// --- message splitting ---

export function splitMessage(text: string, limit: number): string[] {
	if (text.length <= limit) return [text];
	const parts: string[] = [];
	let rest = text;
	while (rest.length > 0) {
		if (rest.length <= limit) {
			parts.push(rest);
			break;
		}
		let at = rest.lastIndexOf("\n", limit);
		if (at < limit * 0.3) at = limit;
		parts.push(rest.slice(0, at));
		rest = rest.slice(at);
	}
	return parts;
}

// --- draft preview model ---

export function createDraftPreviewModel(maxLen: number): DraftPreviewModel {
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
			const preview = buildStreamingPreviewWithToolBlock(
				text,
				toolBlock,
				safeLimit,
			);
			if (!preview) {
				lastPreview = "";
				lastDraftSupportsHtml = draftSupportsHtml;
				lastResult = null;
				return null;
			}
			if (
				preview === lastPreview &&
				draftSupportsHtml === lastDraftSupportsHtml
			) {
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
				if (plainText.length > 4096) plainText = `${plainText.slice(0, 4095)}…`;
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
			lastResult = { draftText, getPlainText, renderKey: `plain:${draftText}` };
			return lastResult;
		},
	};
}

// --- sendMessageDraft caller ---

export async function callSendMessageDraft(
	api: BotContext["api"],
	chatId: number,
	draftId: number,
	text: string,
	messageThreadId?: number,
	parseMode?: "HTML",
): Promise<void> {
	const other: Record<string, unknown> = {};
	if (
		Number.isSafeInteger(messageThreadId) &&
		(messageThreadId as number) > 0
	) {
		other.message_thread_id = messageThreadId as number;
	}
	if (parseMode) other.parse_mode = parseMode;
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

// --- stream updaters ---

export function createDraftStreamUpdater(
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
					await callSendMessageDraft(
						api,
						chatId,
						draftId,
						draftText,
						messageThreadId,
						parseMode,
					);
				} catch (err) {
					let sendErr: unknown = err;
					if (parseMode === "HTML" && isDraftHtmlParseError(sendErr)) {
						draftSupportsHtml = false;
						try {
							const plainText = getPlainText();
							await callSendMessageDraft(
								api,
								chatId,
								draftId,
								plainText,
								messageThreadId,
							);
							lastRendered = `plain:${plainText}`;
							return;
						} catch (fallbackErr) {
							sendErr = fallbackErr;
						}
					}
					if (isMessageNotModifiedError(sendErr)) return;
					if (isTextMustBeNonEmptyError(sendErr)) return;
					if (isSendMessageDraftUnsupportedError(sendErr)) disabled = true;
					try {
						onDraftFallback?.(sendErr);
					} catch {
						/* ignore */
					}
				}
			})
			.catch(() => {
				/* keep chain alive */
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
			await pendingEdit.catch(() => {});
		},
		dispose,
	};
}

export function createSilentStreamUpdater(): StreamUpdater {
	return {
		onTextDelta: () => {},
		onToolStart: () => {},
		onToolError: () => {},
		stopAndWait: async () => {},
		dispose: () => {},
	};
}
