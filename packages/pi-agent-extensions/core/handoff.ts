// handoff — durable, compact continuation state shared by compaction and restarts.

import { Type } from "typebox";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { PI_EVENT } from "./events.ts";
import { prompt } from "./md.ts";

const ENTRY_TYPE = "core-handoff";
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

/** Per-session handle returned to core: the job-event nudge must read this session's state only. */
export interface HandoffHandle {
	nudge(): string | undefined;
}

const hasFacts = (state: Handoff): boolean => Boolean(state.goal) || fields.slice(1).some((field) => (state[field] as string[]).length > 0);

export default function handoff(pi: ExtensionAPI): HandoffHandle {
	// All state is owned by this registration and rebuilt from the session on every
	// session_start / session_tree, so nothing from a previous session survives a switch.
	let state = empty();
	let turnsSinceUpdate = 0;
	// The changing summary goes in as a hidden message, only when the model has not seen this text
	// (first run, after a restart or compaction, or after it changed); the system prompt stays byte-stable.
	let seenSummary: string | undefined;
	const reset = () => {
		state = empty();
		turnsSinceUpdate = 0;
		seenSummary = undefined;
	};
	const persist = () => { state.updated_at = Date.now(); turnsSinceUpdate = 0; pi.appendEntry(ENTRY_TYPE, state); };
	const restore = (ctx: ExtensionContext) => {
		reset();
		for (const entry of ctx.sessionManager.getBranch() as any[]) if (entry.type === "custom" && entry.customType === ENTRY_TYPE && valid(entry.data)) state = normalize(entry.data);
	};
	pi.on(PI_EVENT.SESSION_START, async (_event, ctx) => restore(ctx));
	pi.on(PI_EVENT.SESSION_TREE, async (_event, ctx) => restore(ctx));
	pi.on(PI_EVENT.SESSION_SHUTDOWN, async () => reset());
	pi.on(PI_EVENT.AGENT_START, async () => { turnsSinceUpdate++; });
	pi.on(PI_EVENT.SESSION_COMPACT, async () => { seenSummary = undefined; });
	pi.on(PI_EVENT.BEFORE_AGENT_START, async () => {
		const text = hasFacts(state) ? summary(state) : undefined;
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
	return {
		nudge() {
			if (!hasFacts(state)) return "Handoff is empty; record the current goal, decisions, files, and next step with the handoff tool.";
			if (turnsSinceUpdate >= 5) return `Handoff is ${turnsSinceUpdate} turns old; refresh it with verified progress before continuing.`;
			return undefined;
		},
	};
}
