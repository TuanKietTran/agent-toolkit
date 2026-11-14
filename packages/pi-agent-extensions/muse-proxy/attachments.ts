/**
 * Attachments for Muse.
 *
 * muse-proxy takes text only (it answers 400 "Only text content parts are
 * supported" to an image part), so pi's image blocks never reach Muse as pixels.
 * Instead each image is replaced, before the conversation is planned, by a text
 * surrogate: a header (type, size) plus what a describer could read from it.
 *
 * Describers, first that works wins:
 *  1. `PI_MUSE_PROXY_IMAGE_CMD`: a shell command run as `<cmd> <image path>`
 *     whose stdout is the description (plug in any vision model here).
 *  2. macOS Vision OCR (`ocr.swift`), with coarse position of each text line.
 *  3. Header only.
 * Results are cached by content hash so a turn re-sent later stays identical.
 */

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { clip } from "./session.ts";

const run = promisify(execFile);
const OCR_SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "ocr.swift");
const DESCRIBE_TIMEOUT_MS = 60_000;
export const MAX_DESCRIPTION_CHARS = 6000;

export interface ImageInput {
  data: string; // base64
  mimeType: string;
}

export type Describer = (image: ImageInput) => Promise<string | undefined>;

const EXT: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp" };

/** Pure: the text Muse sees in place of one image. */
export function imageSurrogate(image: ImageInput, description: string | undefined): string {
  const bytes = Math.floor((image.data.length * 3) / 4);
  const header = `[Attached image: ${image.mimeType}, ${(bytes / 1024).toFixed(1)} KB. Muse cannot receive pixels through the proxy, so a text rendering follows.]`;
  const body = description?.trim();
  if (!body) return `${header}\n(no text could be extracted from it)`;
  return `${header}\n${clip(body, MAX_DESCRIPTION_CHARS)}`;
}

async function withTempImage<T>(image: ImageInput, fn: (path: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "muse-img-"));
  try {
    const path = join(dir, `image.${EXT[image.mimeType] ?? "bin"}`);
    writeFileSync(path, Buffer.from(image.data, "base64"), { mode: 0o600 });
    return await fn(path);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const BUILD_TIMEOUT_MS = 240_000;

/** Compiles ocr.swift once (the interpreter needs ~35 s per run) and returns the cached binary. */
async function ocrBinary(): Promise<string> {
  const hash = createHash("sha1").update(readFileSync(OCR_SCRIPT)).digest("hex").slice(0, 12);
  const dir = join(homedir(), ".pi", "agent", "cache");
  const bin = join(dir, `muse-ocr-${hash}`);
  if (existsSync(bin)) return bin;
  mkdirSync(dir, { recursive: true });
  const tmp = `${bin}.${process.pid}.tmp`;
  await run("swiftc", ["-O", OCR_SCRIPT, "-o", tmp], { timeout: BUILD_TIMEOUT_MS });
  renameSync(tmp, bin);
  return bin;
}

export const defaultDescriber: Describer = (image) =>
  withTempImage(image, async (path) => {
    const custom = process.env.PI_MUSE_PROXY_IMAGE_CMD;
    try {
      if (custom) {
        const { stdout } = await run("/bin/sh", ["-c", `${custom} "$1"`, "sh", path], { timeout: DESCRIBE_TIMEOUT_MS, maxBuffer: 1 << 20 });
        return stdout;
      }
      if (process.platform === "darwin") {
        const { stdout } = await run(await ocrBinary(), [path], { timeout: DESCRIBE_TIMEOUT_MS, maxBuffer: 1 << 20 });
        const [size, ...lines] = stdout.split("\n");
        return `Size ${size?.trim()}. Text found by on-device OCR (position in the image, then text):\n${lines.join("\n")}`.trimEnd();
      }
    } catch { /* fall through to header only */ }
    return undefined;
  });

const cache = new Map<string, string>();

interface Block { type: string; text?: string; data?: string; mimeType?: string }
interface Msg { role: string; content: string | Block[] }

/** Replaces every image block in user and tool-result messages with its text surrogate. */
export async function inlineAttachments<T extends Msg>(messages: T[], describe: Describer = defaultDescriber): Promise<T[]> {
  const out: T[] = [];
  for (const message of messages) {
    if (typeof message.content === "string" || !message.content.some((b) => b.type === "image")) {
      out.push(message);
      continue;
    }
    const blocks: Block[] = [];
    for (const block of message.content) {
      if (block.type !== "image" || !block.data) {
        blocks.push(block);
        continue;
      }
      const image = { data: block.data, mimeType: block.mimeType ?? "image/png" };
      const key = createHash("sha1").update(image.data).digest("hex");
      let surrogate = cache.get(key);
      if (surrogate === undefined) {
        surrogate = imageSurrogate(image, await describe(image).catch(() => undefined));
        cache.set(key, surrogate);
      }
      blocks.push({ type: "text", text: surrogate });
    }
    out.push({ ...message, content: blocks });
  }
  return out;
}

/** Fire-and-forget: compile the OCR helper now so the first attachment does not wait for it. */
export function warmUp(): void {
  if (process.platform !== "darwin" || process.env.PI_MUSE_PROXY_IMAGE_CMD) return;
  ocrBinary().catch(() => {});
}
