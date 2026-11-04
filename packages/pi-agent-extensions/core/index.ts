import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import answerFloor from "./guards/answer-floor.ts";
import contextGuard from "./guards/context-guard.ts";
import contextOptimize from "./guards/context-optimize.ts";
import fileToolDiscipline from "./guards/file-tool-discipline.ts";
import { registerReplay } from "./dev/replay.ts";
import { JOB_EVENT_MESSAGE, registerJobEventRenderer } from "./job-event-ui.ts";
import { prompt } from "./md.ts";
import todo, { TOOL_NAME as TODO_TOOL } from "./todo.ts";
import handoff, { HANDOFF_RULES, HANDOFF_TOOL, handoffNudge } from "./handoff.ts";
import rightPanel from "./right-panel.ts";
import { SHELL, Supervisor, type JobEvent, type JobRecord, type KindConfig } from "./supervisor.ts";

import { PI_EVENT } from "./events.ts";

// --- Constants: every local literal lives here. ---

const ENTRY_TYPE = "core_job";
const STEER_STATES = new Set(["completed", "failed", "timed_out", "lost", "cancelled"]);
const ENTRY_CUSTOM = "custom";
const EXTENSIONS_SUBDIR = [".pi", "agent", "extensions", "core"];
const ENV_ALLOW_IRREVERSIBLE = "PI_JOBS_ALLOW_IRREVERSIBLE";
const ENV_ENABLED = "1";
const AGENT_DIR_ENV = "PI_CODING_AGENT_DIR";
const DEFAULT_AGENT_DIR = [".pi", "agent"];
const SETTINGS_FILE = "settings.json";

// Markdown files and headings
const RULES_FILE = "rules.md";
const COMMANDS_FILE = "commands.md";
const JOB_RULES_HEADING = "job-rules";
const RESPONSE_RULES_HEADING = "response-rules";
const TODO_RULES_HEADING = "todo-rules";
const SLA_KEY = "sla_s";
const PROMPT_JOINER = "\n\n";

// Tools and command. Tool schemas are resent with every request, so descriptions stay short.
const START_TOOL = "start_job";
const START_LABEL = "Start job";
const START_DESCRIPTION = "Run a long job in the background; a job_event is steered on completion.";
const KIND_DESCRIPTION = "Job kind: shell, test, interactive (agent/PTY/server; no deadline), watch, deploy";
const COMMAND_DESCRIPTION = "Shell command";
const STATUS_TOOL = "job_status";
const STATUS_LABEL = "Job status";
const STATUS_DESCRIPTION = "Job state snapshot (rare; the host steers changes).";
const CANCEL_TOOL = "cancel_job";
const CANCEL_LABEL = "Cancel job";
const CANCEL_DESCRIPTION = "Cancel a running job.";
const LOGS_TOOL = "job_logs";
const LOGS_LABEL = "Job logs";
const LOGS_DESCRIPTION = "Last N job log lines (max 200).";
const DEFAULT_TAIL = 20;
const JOBS_COMMAND = "jobs";
const JOBS_DESCRIPTION = "List jobs and states";

// Messages
const NO_KINDS_NOTE = `core: no job kinds found in ${COMMANDS_FILE}`;
const NO_JOBS = "no jobs";
const NO_OUTPUT = "(no output)";
const NOTE_WARNING = "warning";
const NOTE_INFO = "info";
const unknownJob = (id: string) => `Unknown job ${id}`;
const jobLine = (j: JobRecord) => `${j.job_id}: ${j.state}`;

function agentDir(): string {
	return process.env[AGENT_DIR_ENV] || path.join(os.homedir(), ...DEFAULT_AGENT_DIR);
}

function allowIrreversibleJobs(): boolean {
	if (process.env[ENV_ALLOW_IRREVERSIBLE] === ENV_ENABLED) return true;
	try {
		const settings = JSON.parse(fs.readFileSync(path.join(agentDir(), SETTINGS_FILE), "utf8"));
		return settings?.jobs?.allowIrreversible === true;
	} catch {
		return false;
	}
}

function coreDir(): string {
	try {
		return path.dirname(fileURLToPath(import.meta.url));
	} catch {
		return path.join(os.homedir(), ...EXTENSIONS_SUBDIR);
	}
}

function readFile(name: string): string {
	try {
		return fs.readFileSync(path.join(coreDir(), name), "utf8");
	} catch {
		return "";
	}
}

/** Extract every ```json fenced block from markdown, parsed. */
function jsonBlocks(md: string): unknown[] {
	const out: unknown[] = [];
	for (const m of md.matchAll(/```json\s*\n([\s\S]*?)```/g)) {
		try {
			out.push(JSON.parse(m[1]));
		} catch {}
	}
	return out;
}

interface CoreConfig {
	rules: string;
	todoRules: string;
	commands: string;
	kinds: Record<string, KindConfig>;
	options: Record<string, string[]>;
}

/** Prompts come from rules.md, job kinds from commands.md. Nothing hardcoded here. */
function loadConfig(): CoreConfig {
	const commands = readFile(COMMANDS_FILE);
	const blocks = jsonBlocks(commands) as Record<string, any>[];
	const kinds = (blocks.find((b) => b && Object.values(b).every((v: any) => v && SLA_KEY in v)) ?? {}) as Record<
		string,
		KindConfig
	>;
	const options = (blocks.find((b) => b && Object.values(b).every((v) => Array.isArray(v))) ?? {}) as Record<
		string,
		string[]
	>;
	return {
		rules: [prompt(RULES_FILE, JOB_RULES_HEADING), prompt(RULES_FILE, RESPONSE_RULES_HEADING)].filter(Boolean).join("\n\n"),
		todoRules: prompt(RULES_FILE, TODO_RULES_HEADING),
		commands,
		kinds,
		options,
	};
}

export default function core(pi: ExtensionAPI) {
	contextGuard(pi);
	answerFloor(pi);
	contextOptimize(pi);
	fileToolDiscipline(pi);
	handoff(pi);
	rightPanel(pi);
	todo(pi);
	registerReplay(pi);
	registerJobEventRenderer(pi);
	let cfg = loadConfig();
	let sup: Supervisor | undefined;
	// Supervisor callbacks can outlive a session (for example, when a job exits
	// during a session switch or extension reload). Never let an old callback use
	// the session-bound `pi` API after that session has been replaced.
	let sessionGeneration = 0;
	const allowIrreversible = allowIrreversibleJobs();

	const text = (t: string, details: unknown = undefined) => ({ content: [{ type: "text" as const, text: t }], details });

	pi.on(PI_EVENT.SESSION_START, async (_e, ctx) => {
		cfg = loadConfig();
		sup?.shutdown();
		const generation = ++sessionGeneration;
		let sessionSup: Supervisor;
		sessionSup = new Supervisor(
			cfg.kinds,
			cfg.options,
			{
				onEvent: (ev: JobEvent) => {
					if (generation !== sessionGeneration || sup !== sessionSup) return;
					if (!STEER_STATES.has(ev.state)) return;
					const nudge = handoffNudge();
					if (nudge) Object.assign(ev, { handoff_nudge: nudge });
					pi.sendMessage(
						{ customType: JOB_EVENT_MESSAGE, content: JSON.stringify(ev), display: true, details: ev },
						{ triggerTurn: true, deliverAs: "steer" },
					);
				},
				onPersist: (rec: JobRecord) => {
					if (generation === sessionGeneration && sup === sessionSup) pi.appendEntry(ENTRY_TYPE, rec);
				},
			},
			allowIrreversible,
		);
		sup = sessionSup;
		const latest = new Map<string, JobRecord>();
		for (const e of ctx.sessionManager.getBranch() as any[]) {
			if (e.type === ENTRY_CUSTOM && e.customType === ENTRY_TYPE && e.data) latest.set(e.data.job_id, e.data);
		}
		sup.restore([...latest.values()]);
		if (Object.keys(cfg.kinds).length === 0) ctx.ui.notify(NO_KINDS_NOTE, NOTE_WARNING);
	});

	pi.on(PI_EVENT.SESSION_SHUTDOWN, async () => {
		// Invalidate callbacks before stopping the supervisor: shutdown can race
		// with child-process events and those callbacks must not touch stale `pi`.
		++sessionGeneration;
		const oldSup = sup;
		sup = undefined;
		oldSup?.shutdown();
	});

	// Re-read the markdown on every run: edits apply immediately, no reload command or tool call.
	// The text appended here is the same on every run while the tool set is, so the cached
	// prompt prefix survives; each block is only sent while the tool it explains is active.
	pi.on(PI_EVENT.BEFORE_AGENT_START, async (event) => {
		cfg = loadConfig();
		sup?.setConfig(cfg.kinds, cfg.options);
		const active = new Set(pi.getActiveTools());
		const blocks: string[] = [];
		if (active.has(TODO_TOOL) && cfg.todoRules) blocks.push(cfg.todoRules);
		if (active.has(HANDOFF_TOOL) && HANDOFF_RULES) blocks.push(HANDOFF_RULES);
		return { systemPrompt: [event.systemPrompt, cfg.rules, ...blocks].filter(Boolean).join(PROMPT_JOINER) };
	});

	pi.registerCommand(JOBS_COMMAND, {
		description: JOBS_DESCRIPTION,
		handler: async (_a, ctx) => {
			const l = sup?.list() ?? [];
			ctx.ui.notify(l.length ? l.map(jobLine).join("\n") : NO_JOBS, NOTE_INFO);
		},
	});

	// Jobs run under SHELL. Without it (native Windows) start_job could only fail, so the
	// four job tools and the job rules are left out instead of costing tokens on every request.
	if (!fs.existsSync(SHELL)) return;

	pi.registerTool({
		name: START_TOOL,
		label: START_LABEL,
		description: START_DESCRIPTION,
		parameters: Type.Object({
			kind: Type.String({ description: KIND_DESCRIPTION }),
			spec: Type.Object({
				command: Type.String({ description: COMMAND_DESCRIPTION }),
				cwd: Type.Optional(Type.String()),
			}),
		}),
		async execute(_id, p, _sig, _upd, ctx) {
			const rec = sup!.start(p.kind, p.spec.command, p.spec.cwd ?? ctx.cwd);
			return text(
				JSON.stringify({
					job_id: rec.job_id,
					state: rec.state,
					sla_s: rec.sla_s,
					heartbeat_s: rec.heartbeat_s,
					cancelable: rec.cancelable,
					reversible: rec.reversible,
				}),
				rec,
			);
		},
	});

	pi.registerTool({
		name: STATUS_TOOL,
		label: STATUS_LABEL,
		description: STATUS_DESCRIPTION,
		parameters: Type.Object({ job_id: Type.String() }),
		async execute(_id, p) {
			const s = sup!.status(p.job_id);
			if (!s) throw new Error(unknownJob(p.job_id));
			return text(JSON.stringify(s), s);
		},
	});

	pi.registerTool({
		name: CANCEL_TOOL,
		label: CANCEL_LABEL,
		description: CANCEL_DESCRIPTION,
		parameters: Type.Object({ job_id: Type.String() }),
		async execute(_id, p) {
			return text(sup!.cancel(p.job_id));
		},
	});

	pi.registerTool({
		name: LOGS_TOOL,
		label: LOGS_LABEL,
		description: LOGS_DESCRIPTION,
		parameters: Type.Object({ job_id: Type.String(), tail: Type.Optional(Type.Number({ default: DEFAULT_TAIL })) }),
		async execute(_id, p) {
			const lines = sup!.logs(p.job_id, p.tail ?? DEFAULT_TAIL);
			if (!lines) throw new Error(unknownJob(p.job_id));
			return text(lines.join("\n") || NO_OUTPUT);
		},
	});

}
