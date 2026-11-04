// handoff — durable, compact continuation state shared by compaction and restarts.

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Type } from "typebox";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { PI_EVENT } from "./events.ts";
import { prompt } from "./md.ts";

const ENTRY_TYPE = "core-handoff";
const FILE_NAME = "handoff.json";
const TOOL_NAME = "handoff";
const MAX_ITEMS = 12;
const MAX_TEXT = 800;
const MAX_SUMMARY = 6000;
const NOTE_INFO = "info";
const SUMMARY_ENTRY = "core-handoff-summary";
export const HANDOFF_TOOL = TOOL_NAME;
// Static text: index.ts adds it to the system prompt while the tool is active, so the cached prefix survives.
export const HANDOFF_RULES = prompt("rules.md", "handoff-guidance");
const fields = ["goal", "constraints", "decisions", "done", "in_progress", "files", "verification", "errors", "next", "rollback"] as const;
type Field = typeof fields[number];
// The model-facing names; constraints and rollback stay in the stored shape but cost schema tokens every turn.
const TOOL_FIELDS = fields.filter((field) => field !== "constraints" && field !== "rollback");
type Handoff = { goal?: string; constraints: string[]; decisions: string[]; done: string[]; in_progress: string[]; files: string[]; verification: string[]; errors: string[]; next: string[]; rollback: string[]; updated_at: number };


const empty = (): Handoff => ({ constraints: [], decisions: [], done: [], in_progress: [], files: [], verification: [], errors: [], next: [], rollback: [], updated_at: Date.now() });
let latestState = empty();
let latestTurns = 0;
const clean = (value: unknown): string => String(value ?? "").trim().slice(0, MAX_TEXT);
const list = (value: unknown): string[] => Array.isArray(value) ? value.map(clean).filter(Boolean).slice(0, MAX_ITEMS) : [];
function valid(value: unknown): value is Handoff {
	if (!value || typeof value !== "object") return false;
	const x = value as Partial<Handoff>;
	return typeof x.updated_at === "number" && fields.slice(1).every((field) => Array.isArray(x[field]));
}
function normalize(value: unknown): Handoff {
	const x = value as Partial<Handoff>;
	return { goal: clean(x.goal) || undefined, constraints: list(x.constraints), decisions: list(x.decisions), done: list(x.done), in_progress: list(x.in_progress), files: list(x.files), verification: list(x.verification), errors: list(x.errors), next: list(x.next), rollback: list(x.rollback), updated_at: Date.now() };
}
function summary(state: Handoff): string {
	const lines = ["# Durable continuation handoff", state.goal && `Goal: ${state.goal}`, ...fields.slice(1).map((field) => {
		const values = state[field] as string[];
		return values.length ? `${field}:\n${values.map((value) => `- ${value}`).join("\n")}` : "";
	})].filter(Boolean);
	return lines.join("\n").slice(0, MAX_SUMMARY);
}
function writeDurable(ctx: ExtensionContext, state: Handoff): void {
	try {
		const dir = ctx.sessionManager.getSessionDir();
		mkdirSync(dir, { recursive: true });
		const target = join(dir, FILE_NAME);
		const temp = `${target}.tmp`;
		writeFileSync(temp, JSON.stringify(state), "utf8");
		renameSync(temp, target);
	} catch { /* session entries remain the fallback */ }
}
function readDurable(ctx: ExtensionContext): Handoff | undefined {
	try {
		const value = JSON.parse(readFileSync(join(ctx.sessionManager.getSessionDir(), FILE_NAME), "utf8"));
		return valid(value) ? normalize(value) : undefined;
	} catch { return undefined; }
}

export default function handoff(pi: ExtensionAPI): void {
	let state = empty();
	let context: ExtensionContext | undefined;
	let turnsSinceUpdate = 0;
	const persist = () => { state.updated_at = Date.now(); turnsSinceUpdate = 0; latestState = state; latestTurns = 0; pi.appendEntry(ENTRY_TYPE, state); if (context) writeDurable(context, state); };
	const restore = (ctx: ExtensionContext) => {
		context = ctx;
		const saved = readDurable(ctx);
		for (const entry of ctx.sessionManager.getBranch() as any[]) if (entry.type === "custom" && entry.customType === ENTRY_TYPE && valid(entry.data)) state = normalize(entry.data);
		if (saved && saved.updated_at > state.updated_at) state = saved;
		turnsSinceUpdate = 0;
		latestState = state;
		latestTurns = 0;
		seenSummary = undefined;
	};
	pi.on(PI_EVENT.SESSION_START, async (_event, ctx) => restore(ctx));
	pi.on(PI_EVENT.SESSION_TREE, async (_event, ctx) => restore(ctx));
	pi.on(PI_EVENT.AGENT_START, async () => { turnsSinceUpdate++; latestTurns = turnsSinceUpdate; });
	// The changing summary goes in as a hidden message, only when the model has not seen this text
	// (first run, after a restart or compaction, or after it changed); the system prompt stays byte-stable.
	let seenSummary: string | undefined;
	pi.on(PI_EVENT.SESSION_COMPACT, async () => { seenSummary = undefined; });
	pi.on(PI_EVENT.BEFORE_AGENT_START, async () => {
		const hasFacts = Boolean(state.goal) || fields.slice(1).some((field) => (state[field] as string[]).length > 0);
		const text = hasFacts ? summary(state) : undefined;
		if (text === seenSummary) return;
		seenSummary = text;
		if (!text) return;
		return { message: { customType: SUMMARY_ENTRY, display: false, content: text } };
	});
	pi.registerTool({
		name: TOOL_NAME,
		label: "Handoff",
		description: `field: ${TOOL_FIELDS.join("|")}; items replaces, [] clears`,
		parameters: Type.Object({ field: Type.String(), items: Type.Array(Type.String()) }),
		async execute(_id, input: { field: string; items: string[] }) {
			if (!(TOOL_FIELDS as readonly string[]).includes(input.field)) throw new Error(`unknown field: ${input.field}`);
			const next = { ...state } as any;
			next[input.field] = input.field === "goal" ? (input.items[0] ?? "") : input.items;
			state = normalize(next);
			persist();
			return { content: [{ type: "text" as const, text: summary(state) }], details: state };
		},
	});
	pi.registerCommand("handoff", { description: "Show durable continuation state; \"clear\" resets it", handler: async (args, ctx) => { if (args?.trim() === "clear") { state = empty(); persist(); } ctx.ui.notify(summary(state), NOTE_INFO); } });
}

export function handoffNudge(): string | undefined {
	const hasFacts = Boolean(latestState.goal) || fields.slice(1).some((field) => (latestState[field] as string[]).length > 0);
	if (!hasFacts) return "Handoff is empty; record the current goal, decisions, files, and next step with the handoff tool.";
	if (latestTurns >= 5) return `Handoff is ${latestTurns} turns old; refresh it with verified progress before continuing.`;
	return undefined;
}
