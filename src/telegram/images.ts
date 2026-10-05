// src/telegram/images.ts — image download, dedup, MIME inference, model support
import { createHash } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve } from "node:path";
import type { PiImage } from "../pi/types.js";
import type { PiPool } from "../pi/pool.js";
import type { BotContext, LoadedImage } from "./bot-context.js";

const inboundDirCache = new Set<string>();

// --- MIME / extension inference ---

export function inferImageMimeFromPath(path: string, fallback: string): string {
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

export function inferImageExtFromPath(path: string, mimeType: string): string {
	const ext = path.split(".").pop()?.toLowerCase() || "";
	return ext || inferImageExtFromMime(mimeType);
}

export function inferImageExtFromMime(mimeType: string): string {
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

export function hashImageBuffer(buffer: Buffer): string {
	return createHash("sha256").update(buffer).digest("hex");
}

export function sanitizeFileToken(s: string): string {
	const cleaned = s.replace(/[^a-zA-Z0-9._-]/g, "_");
	return cleaned.slice(0, 120) || "file";
}

export function resolveInboundImagePath(
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

// --- download ---

export async function downloadInboundFileByFileId(
	tgCtx: BotContext,
	token: string,
	fileId: string,
	fallbackMimeType = "application/octet-stream",
	includeImage = true,
): Promise<LoadedImage | null> {
	try {
		const file = (await tgCtx.api.getFile(fileId)) as any;
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
			if (!buffer) buffer = await readFile(localPath);
			contentHash = hashImageBuffer(buffer);
			return {
				fileId,
				localPath,
				contentHash,
				image: { type: "image", data: buffer.toString("base64"), mimeType },
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

export async function downloadImageByFileId(
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
	if (!loaded?.image) return null;
	return loaded;
}

// --- dedup ---

export function ensureImageHash(img: LoadedImage): string | undefined {
	if (img.contentHash) return img.contentHash;
	if (!img.image) return undefined;
	img.contentHash = createHash("sha256").update(img.image.data).digest("hex");
	return img.contentHash;
}

interface DedupedImageGroups {
	current: LoadedImage[];
	referenced: LoadedImage[];
	all: LoadedImage[];
}

export function dedupeLoadedImageGroups(
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

export function toPromptPathList(images: LoadedImage[]): string[] {
	const seen = new Set<string>();
	const out: string[] = [];
	for (const img of images) {
		const p = img.localPath.replace(/\\/g, "/");
		const key = p.toLowerCase();
		if (seen.has(key)) continue;
		seen.add(key);
		out.push(p);
	}
	return out;
}

// --- model image support ---

export function parseModelImageSupport(model: any): boolean | undefined {
	if (!model || typeof model !== "object") return undefined;
	if (Array.isArray(model.input)) return model.input.includes("image");
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

export async function supportsImagesForChat(
	chatId: number,
	inst: ReturnType<PiPool["get"]>,
	cache: Map<number, { value: boolean; at: number }>,
): Promise<boolean> {
	const cached = cache.get(chatId);
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
				/* ignore */
			}
		}
		if (typeof parsed === "boolean") value = parsed;
	} catch {
		/* ignore */
	}

	cache.set(chatId, { value, at: now });
	return value;
}

// --- referenced images from reply context ---

export async function collectReferencedImages(
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
			const img = await downloadImageByFileId(
				tgCtx,
				token,
				photo.file_id,
				"image/jpeg",
				includeImage,
			);
			if (img) images.push(img);
		}
	}

	if (
		replied.document?.file_id &&
		String(replied.document?.mime_type || "").startsWith("image/")
	) {
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
