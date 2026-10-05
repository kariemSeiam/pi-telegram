// src/telegram/delivery.ts — reply preparation, sending, attachment dispatch
import type { ReplyParameters } from "@grammyjs/types";
import { log } from "../shared/log.js";
import type {
	BotContext,
	CronPreparedReply,
	PreparedReply,
} from "./bot-context.js";
import type { TgAttachment, TgAttachmentKind } from "./attachment.js";
import { extractTgAttachments } from "./attachment.js";
import {
	extractTgReplyDirective,
	rememberReplyMessage,
	resolveReplyParameters,
} from "./reply.js";
import { mdToPlainText, mdToTgHtml } from "./format.js";
import { stripProtocolTags, splitMessage } from "./streaming.js";
import { replyScopeKey, describeTelegramSendError } from "./utils.js";

// --- attachment dispatch tables ---

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

export const REPLY_BY_KIND: Record<TgAttachmentKind, ReplyMethodName> = {
	photo: "replyWithPhoto",
	document: "replyWithDocument",
	video: "replyWithVideo",
	audio: "replyWithAudio",
	animation: "replyWithAnimation",
	voice: "replyWithVoice",
	video_note: "replyWithVideoNote",
	sticker: "replyWithSticker",
};

const REPLY_SENDER: Record<
	ReplyMethodName,
	(ctx: BotContext, media: MediaInput, other?: SendOther) => Promise<unknown>
> = {
	replyWithPhoto: (ctx, media, other) => ctx.replyWithPhoto(media, other),
	replyWithDocument: (ctx, media, other) => ctx.replyWithDocument(media, other),
	replyWithVideo: (ctx, media, other) => ctx.replyWithVideo(media, other),
	replyWithAudio: (ctx, media, other) => ctx.replyWithAudio(media, other),
	replyWithAnimation: (ctx, media, other) =>
		ctx.replyWithAnimation(media, other),
	replyWithVoice: (ctx, media, other) => ctx.replyWithVoice(media, other),
	replyWithVideoNote: (ctx, media, other) =>
		ctx.replyWithVideoNote(media, other),
	replyWithSticker: (ctx, media, other) => ctx.replyWithSticker(media, other),
};

// --- reply preparation ---

export function prepareCronReply(
	text: string,
	tools: string[],
): CronPreparedReply {
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

export function prepareReply(
	tgCtx: BotContext,
	text: string,
	tools: string[],
	extraWarnings: string[] = [],
): PreparedReply {
	const extractedReply = extractTgReplyDirective(text || "");
	const extracted = extractTgAttachments(extractedReply.text);
	const resolvedReply = resolveReplyParameters(
		replyScopeKey(tgCtx),
		extractedReply.directive,
	);
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
		warnings: [
			...extractedReply.warnings,
			...extracted.warnings,
			...resolvedReply.warnings,
			...extraWarnings,
		],
		replyParameters: resolvedReply.replyParameters,
	};
}

// --- sending ---

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

export async function sendAttachments(
	tgCtx: BotContext,
	attachments: TgAttachment[],
	warnings: string[],
	replyParameters?: ReplyParameters,
): Promise<void> {
	if (warnings.length) {
		const preview = warnings.slice(0, 3).join("\n");
		const more =
			warnings.length > 3
				? `\n... and ${warnings.length - 3} items in queue`
				: "";
		await tgCtx
			.reply(`⚠️ Attachment parse warnings: \n${preview}${more}`)
			.catch(() => {});
	}
	let first = true;
	for (const att of attachments) {
		try {
			const opts =
				first && replyParameters
					? { reply_parameters: replyParameters }
					: undefined;
			await sendOneAttachment(tgCtx, att, opts);
		} catch (err) {
			await tgCtx
				.reply(
					`❌ Attachment send failed: ${att.label || "Unknown attachment"}\n${(err as Error).message}`,
				)
				.catch(() => {});
		}
		first = false;
	}
}

const RICH_MESSAGES = process.env.PITG_RICH_MESSAGES === "1";

export async function sendPreparedReply(
	tgCtx: BotContext,
	prepared: PreparedReply,
	maxLen: number,
): Promise<void> {
	let first = true;
	if (prepared.body.trim()) {
		for (const part of splitMessage(prepared.body, maxLen)) {
			const html = mdToTgHtml(part);
			const opts =
				first && prepared.replyParameters
					? { reply_parameters: prepared.replyParameters }
					: undefined;
			try {
				// Opt-in (PITG_RICH_MESSAGES=1): Telegram Rich Messages keep tables,
				// collapsible details and formulas. Any failure falls through to HTML.
				let sent: { message_id: number } | undefined;
				if (RICH_MESSAGES) {
					try {
						sent = await tgCtx.replyWithRichMessage(
							{ markdown: stripProtocolTags(part) },
							opts,
						);
					} catch (richErr) {
						log.warn(
							`chat${tgCtx.chat?.id ?? 0} rich send failed, falling back to HTML: ${describeTelegramSendError(richErr)}`,
						);
					}
				}
				sent ??= await tgCtx.reply(html, {
					parse_mode: "HTML",
					...(opts ?? {}),
				});
				rememberReplyMessage(
					replyScopeKey(tgCtx),
					"self",
					sent.message_id,
					part,
				);
			} catch (err) {
				log.warn(
					`chat${tgCtx.chat?.id ?? 0} HTML send failed, falling back to plain text: ${describeTelegramSendError(err)}`,
				);
				const safePart = stripProtocolTags(part);
				const plain = mdToPlainText(safePart);
				const sent = await tgCtx.reply(plain, opts);
				rememberReplyMessage(
					replyScopeKey(tgCtx),
					"self",
					sent.message_id,
					plain,
				);
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

export async function sendReply(
	tgCtx: BotContext,
	text: string,
	tools: string[],
	maxLen: number,
	extraWarnings: string[] = [],
): Promise<void> {
	const prepared = prepareReply(tgCtx, text, tools, extraWarnings);
	await sendPreparedReply(tgCtx, prepared, maxLen);
}
