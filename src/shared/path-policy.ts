// src/shared/path-policy.ts — which local files the model may send to Telegram
//
// The model controls <tg-attachment path="..."> text, and that text can be steered
// by anything it reads (web pages, files, messages). So a local path is never trusted:
// it must resolve (symlinks included) to a file inside an allowed root, and must not
// look like a credential.
import { realpathSync, statSync } from "node:fs";
import { basename, isAbsolute, relative, resolve, sep } from "node:path";

let allowedRoots: string[] = [];

/** Set once at startup. Roots are resolved through symlinks so a link cannot escape. */
export function configureAttachmentRoots(roots: string[]): void {
  allowedRoots = roots
    .filter(Boolean)
    .map((r) => {
      try {
        return realpathSync(resolve(r));
      } catch {
        return resolve(r);
      }
    });
}

export function getAttachmentRoots(): readonly string[] {
  return allowedRoots;
}

const SECRET_NAME = [
  /^\.env(\..*)?$/i,
  /^\.npmrc$/i,
  /^\.netrc$/i,
  /^\.git-credentials$/i,
  /^auth\.json$/i,
  /^credentials(\.json)?$/i,
  /\.credentials\.json$/i,
  /^settings\.json$/i, // holds the bot token
  /^id_(rsa|dsa|ecdsa|ed25519)(\.pub)?$/i,
  /\.(pem|key|p12|pfx|kdbx)$/i,
];

const SECRET_DIR = new Set([".git", ".ssh", ".gnupg", ".aws", ".kube", ".docker"]);

export type PathVerdict = { ok: true; real: string } | { ok: false; reason: string };

export function checkLocalAttachmentPath(rawPath: string): PathVerdict {
  if (!allowedRoots.length) return { ok: false, reason: "local attachments are disabled" };
  if (!isAbsolute(rawPath)) return { ok: false, reason: "path must be absolute" };

  let real: string;
  try {
    real = realpathSync(rawPath);
  } catch {
    return { ok: false, reason: "path does not exist" };
  }

  const inside = allowedRoots.some((root) => {
    const rel = relative(root, real);
    return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
  });
  if (!inside) return { ok: false, reason: "path is outside the allowed workspace" };

  const parts = real.split(sep);
  if (parts.some((p) => SECRET_DIR.has(p.toLowerCase()))) {
    return { ok: false, reason: "path is inside a protected directory" };
  }
  const name = basename(real);
  if (SECRET_NAME.some((re) => re.test(name))) {
    return { ok: false, reason: "file looks like a credential" };
  }

  try {
    if (!statSync(real).isFile()) return { ok: false, reason: "not a regular file" };
  } catch {
    return { ok: false, reason: "path cannot be read" };
  }
  return { ok: true, real };
}
