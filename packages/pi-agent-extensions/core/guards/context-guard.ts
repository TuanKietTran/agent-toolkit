/**
 * context-guard — stops a single tool result from blowing the context window.
 *
 * pi's built-in cap is 50KB / 2000 lines, which is ~12k tokens: fine for a
 * 200k cloud model, fatal for a local one. A `ls -R` that returned 31KB is what
 * wedged session 01a039e0 — every retry resent the oversized history and the
 * llama.cpp server answered 400 exceed_context_size_error forever.
 *
 * This scales the cap to whatever model is actually active (a share of its
 * context window) and spills the full output to a file so nothing is lost.
 *
 * Truncation keeps both ends and elides the middle. A recursive listing names
 * its directories at the top while a build or test run puts the verdict at the
 * bottom, and the tool name alone does not say which of the two a `bash` call
 * is, so keeping one end only guesses wrong half the time.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { formatSize } from "@earendil-works/pi-coding-agent";
import { limits } from "../md.ts";

import { PI_EVENT } from "../events.ts";

// --- Constants: every local literal lives here. ---

const CONTEXTS_FILE = "contexts.md";
const LIMITS_NAME = "context-guard";
const SPILL_SUBDIR = "pi-context-guard";
const ENCODING = "utf8";
const LINE_BREAK = "\n";
const BLOCK_TEXT = "text";
const NOTE_INFO = "info";
const elision = (omitted: number) => `[… ${omitted} lines elided by context-guard …]`;
const noticeHead = (kept: number, total: number) => `\n\n[context-guard: kept ${kept} of ${total} lines`;
const noticeSizes = (kept: string, total: string) => ` (${kept} of ${total}).`;
const noticePi = (path: string | undefined) => ` Complete untruncated output: ${path}.`;
const noticeSpilled = (path: string) => ` Output as received: ${path}.`;
const NOTICE_UNSAVED = ` The trimmed content could not be saved.`;
const NOTICE_ADVICE =
	` Do NOT re-run the same broad command — narrow it (head/tail, a subdirectory,` +
	` --max-depth) or grep the saved file instead.]`;
const noteTrimmed = (tool: string, size: string) => `context-guard trimmed ${tool} output to ${size}`;

// Limits live in contexts.md (see there for what each one means).
const cfg = limits<{
	result_share: number;
	chars_per_token: number;
	min_bytes: number;
	max_bytes: number;
	max_lines: number;
	head_share: number;
}>(CONTEXTS_FILE, LIMITS_NAME);
const RESULT_SHARE = cfg.result_share;
const CHARS_PER_TOKEN = cfg.chars_per_token;
const MIN_BYTES = cfg.min_bytes;
const MAX_BYTES = cfg.max_bytes;
const MAX_LINES = cfg.max_lines;
const HEAD_SHARE = cfg.head_share;

const SPILL_DIR = join(tmpdir(), SPILL_SUBDIR);

interface Trim {
	content: string;
	truncated: boolean;
	keptLines: number;
	totalLines: number;
	keptBytes: number;
	totalBytes: number;
}

function bytes(s: string): number {
	return Buffer.byteLength(s, ENCODING);
}

function trimMiddle(text: string, maxBytes: number, maxLines: number): Trim {
	const totalBytes = bytes(text);
	const lines = text.split(LINE_BREAK);
	const totalLines = lines.length;
	if (totalBytes <= maxBytes && totalLines <= maxLines) {
		return { content: text, truncated: false, keptLines: totalLines, totalLines, keptBytes: totalBytes, totalBytes };
	}

	const maxHeadLines = Math.floor(maxLines * HEAD_SHARE);
	const maxHeadBytes = Math.floor(maxBytes * HEAD_SHARE);
	const head: string[] = [];
	let headBytes = 0;
	for (const line of lines) {
		if (head.length >= maxHeadLines || headBytes + bytes(line) + 1 > maxHeadBytes) break;
		head.push(line);
		headBytes += bytes(line) + 1;
	}

	const maxTailLines = maxLines - head.length;
	const maxTailBytes = maxBytes - headBytes;
	const tail: string[] = [];
	let tailBytes = 0;
	for (let i = lines.length - 1; i >= head.length; i--) {
		const line = lines[i];
		if (tail.length >= maxTailLines || tailBytes + bytes(line) + 1 > maxTailBytes) break;
		tail.unshift(line);
		tailBytes += bytes(line) + 1;
	}

	const omitted = totalLines - head.length - tail.length;
	const content = [...head, elision(omitted), ...tail].join(LINE_BREAK);
	return {
		content,
		truncated: true,
		keptLines: head.length + tail.length,
		totalLines,
		keptBytes: bytes(content),
		totalBytes,
	};
}

function budgetFor(ctx: ExtensionContext): number {
	const window = (ctx.model as { contextWindow?: number } | undefined)?.contextWindow;
	if (!window) return MAX_BYTES;
	const budget = Math.floor(window * RESULT_SHARE * CHARS_PER_TOKEN);
	return Math.min(MAX_BYTES, Math.max(MIN_BYTES, budget));
}

function spill(toolName: string, toolCallId: string, text: string): string | undefined {
	try {
		mkdirSync(SPILL_DIR, { recursive: true });
		const path = join(SPILL_DIR, `${toolName}-${toolCallId}.txt`);
		writeFileSync(path, text, ENCODING);
		return path;
	} catch {
		return undefined;
	}
}

export default function (pi: ExtensionAPI) {
	pi.on(PI_EVENT.TOOL_RESULT, (event, ctx) => {
		const blocks = Array.isArray(event.content) ? event.content : [];
		const textBlocks = blocks.filter((b: any) => b?.type === BLOCK_TEXT);
		if (textBlocks.length === 0) return;

		const full = textBlocks.map((b: any) => b.text ?? "").join(LINE_BREAK);
		const trim = trimMiddle(full, budgetFor(ctx), MAX_LINES);
		if (!trim.truncated) return;

		// When pi's own 50KB/2000-line cap already fired it saved the genuinely
		// complete output; point at that rather than spilling a second, shorter copy.
		const piPath = (event.details as { fullOutputPath?: string } | undefined)?.fullOutputPath;
		const path = piPath ?? spill(event.toolName, event.toolCallId, full);
		let notice = noticeHead(trim.keptLines, trim.totalLines);
		notice += noticeSizes(formatSize(trim.keptBytes), formatSize(trim.totalBytes));
		if (piPath) {
			notice += noticePi(path);
		} else if (path) {
			notice += noticeSpilled(path);
		} else {
			notice += NOTICE_UNSAVED;
		}
		notice += NOTICE_ADVICE;

		if (ctx.hasUI) {
			ctx.ui.notify(noteTrimmed(event.toolName, formatSize(trim.keptBytes)), NOTE_INFO);
		}

		// Keep non-text blocks (images etc.) after the trimmed text.
		const kept = blocks.filter((b: any) => b?.type !== BLOCK_TEXT);
		return { content: [{ type: BLOCK_TEXT, text: trim.content + notice }, ...kept] };
	});
}
