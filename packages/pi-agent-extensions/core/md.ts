import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

// --- Constants: every local literal lives here. ---

const CORE_DIR = path.dirname(fileURLToPath(import.meta.url));
const ENCODING = "utf8";
const JSON_BLOCK = /```json\s*\n([\s\S]*?)```/g;
const PLACEHOLDER = /\{\{(\w+)\}\}/g;
const promptPattern = (name: string) =>
	new RegExp(`^## ${name}[^\\n]*\\n[\\s\\S]*?\`\`\`text\\n([\\s\\S]*?)\`\`\``, "m");

/** Read a file relative to core/. Returns "" when missing so callers stay fail-soft. */
export function readCore(rel: string): string {
	try {
		return fs.readFileSync(path.join(CORE_DIR, rel), ENCODING);
	} catch {
		return "";
	}
}

/** Every ```json fenced block in the markdown, parsed. */
export function jsonBlocks(md: string): unknown[] {
	const out: unknown[] = [];
	for (const m of md.matchAll(JSON_BLOCK)) {
		try {
			out.push(JSON.parse(m[1]));
		} catch {}
	}
	return out;
}

/** First ```text fenced block under the `## name` heading. */
export function prompt(rel: string, name: string): string {
	const m = readCore(rel).match(promptPattern(name));
	return m ? m[1].trim() : "";
}

/** Replace `{{name}}` placeholders; unknown names become empty. */
export function fill(template: string, vars: Record<string, string | number>): string {
	return template.replace(PLACEHOLDER, (_, k: string) => String(vars[k] ?? ""));
}

/** Limits for one extension, from the first json block of the given md file that has its key. */
export function limits<T>(rel: string, name: string): T {
	const blocks = jsonBlocks(readCore(rel)) as Record<string, unknown>[];
	return (blocks.find((b) => b && name in b)?.[name] ?? {}) as T;
}
