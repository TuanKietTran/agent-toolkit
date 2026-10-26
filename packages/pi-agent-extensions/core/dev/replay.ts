import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Supervisor, type JobEvent, type JobRecord, type JobState, type KindConfig } from "../supervisor.ts";

// --- Constants: every local literal lives here. ---

const COMMAND_NAME = "core-replay";
const COMMAND_DESCRIPTION = "Replay job-bus scenarios: /core-replay [all|pass|hang|lost|cancel|resume] [live]";
const STATUS_KEY = "core-replay";
const ARG_ALL = "all";
const ARG_LIVE = "live";
const KIND_SHELL = "shell";
const KIND_WATCH = "watch";
const CLASS_IDEMPOTENT = "idempotent";
const TMP_DIR = "/tmp";
const CMD_ECHO = "echo tests ok";
const CMD_SLEEP = "sleep 30";
const STATE_COMPLETED = "completed";
const STATE_TIMED_OUT = "timed_out";
const STATE_CANCELLED = "cancelled";
const STATE_LOST = "lost";
const STATE_RUNNING = "running";
const RESUME_JOB_ID = "shell-99";
const DEAD_PID = 2 ** 22 - 1;
const RESUME_AGE_MS = 5000;
const RESUME_SLA_S = 60;
const CANCEL_DELAY_MS = 400;
const TIMEOUT_CANCEL_DELAY_MS = 300;
const DONE_DELAY_MS = 100;
const GUARD_MS = 8000;
const NOTE_INFO = "info";
const NOTE_WARNING = "warning";
const NOTE_ERROR = "error";
const STEER = "steer";
const unknownScenario = (pick: string, names: string[]) => `unknown scenario '${pick}'. Use: all, ${names.join(", ")}`;
const scenarioHeader = (name: string, desc: string) => `▶ ${name}: ${desc}`;
const scenarioResult = (ok: boolean, expect: string[], got: string[]) =>
	`${ok ? "✔ PASS" : "✘ FAIL"} expected [${expect.join(",")}] got [${got.join(",")}]`;
const eventLine = (ev: JobEvent) =>
	`  ${ev.job_id} ${ev.state}${ev.step ? ` [${ev.step}]` : ""} ${ev.elapsed_s}s "${ev.last_line}" opts=${ev.options.join("|")}`;
const replayMessage = (ev: JobEvent) => `[replay] ${JSON.stringify(ev)}`;
const statusLabel = (name: string) => `replay: ${name}`;
const summaryEntry = (ok: boolean, name: string) => `${ok ? "PASS" : "FAIL"} ${name}`;
const doneNote = (live: boolean, summary: string[]) => `replay done${live ? " (live steer)" : ""}: ${summary.join(", ")}`;

/** Short SLAs so every scenario finishes in seconds. Isolated from the real supervisor. */
const KINDS: Record<string, KindConfig> = {
	[KIND_SHELL]: { sla_s: 2, heartbeat_s: 0, class: CLASS_IDEMPOTENT, cancelable: true },
	[KIND_WATCH]: { sla_s: 30, heartbeat_s: 1, class: CLASS_IDEMPOTENT, cancelable: true },
};

const OPTIONS: Record<string, string[]> = {
	timed_out: ["cancel", "keep_waiting", "rollback", "inspect_logs"],
	lost: ["cancel", "inspect_logs", "restart"],
	failed: ["inspect_logs", "restart"],
};

interface Scenario {
	name: string;
	desc: string;
	expect: JobState[];
	run(sup: Supervisor): void;
}

const SCENARIOS: Scenario[] = [
	{
		name: "pass",
		desc: "test passes -> one completed",
		expect: [STATE_COMPLETED],
		run: (s) => void s.start(KIND_SHELL, CMD_ECHO, TMP_DIR),
	},
	{
		name: "hang",
		desc: "job hangs -> timed_out, then operator cancels",
		expect: [STATE_TIMED_OUT, STATE_CANCELLED],
		run: (s) => void s.start(KIND_SHELL, CMD_SLEEP, TMP_DIR),
	},
	{
		name: "lost",
		desc: "silent process, heartbeat missed -> lost (never completed)",
		expect: [STATE_LOST],
		run: (s) => void s.start(KIND_WATCH, CMD_SLEEP, TMP_DIR),
	},
	{
		name: "cancel",
		desc: "user cancels mid-job -> cancelled",
		expect: [STATE_CANCELLED],
		run: (s) => {
			const r = s.start(KIND_SHELL, CMD_SLEEP, TMP_DIR);
			setTimeout(() => s.cancel(r.job_id), CANCEL_DELAY_MS);
		},
	},
	{
		name: "resume",
		desc: "resume with a running record and dead pid -> lost",
		expect: [STATE_LOST],
		run: (s) => {
			const rec: JobRecord = {
				job_id: RESUME_JOB_ID,
				kind: KIND_SHELL,
				command: CMD_SLEEP,
				cwd: TMP_DIR,
				state: STATE_RUNNING,
				pid: DEAD_PID,
				started_at: Date.now() - RESUME_AGE_MS,
				sla_s: RESUME_SLA_S,
				heartbeat_s: 0,
				reversible: true,
				cancelable: true,
			};
			s.restore([rec]);
		},
	},
];

function runScenario(sc: Scenario, log: (line: string) => void, forward?: (ev: JobEvent) => void) {
	return new Promise<{ ok: boolean; got: JobState[] }>((resolve) => {
		const got: JobState[] = [];
		let sup: Supervisor;
		const done = (ok: boolean) => {
			clearTimeout(guard);
			sup.shutdown();
			resolve({ ok, got });
		};
		const guard = setTimeout(() => done(false), GUARD_MS);
		sup = new Supervisor(
			KINDS,
			OPTIONS,
			{
				onPersist() {},
				onEvent(ev) {
					got.push(ev.state);
					log(eventLine(ev));
					forward?.(ev);
					// Stand-in for the model's decision so the process does not linger.
					if (ev.state === STATE_TIMED_OUT) setTimeout(() => sup.cancel(ev.job_id), TIMEOUT_CANCEL_DELAY_MS);
					if (got.length >= sc.expect.length) setTimeout(() => done(sc.expect.every((s, i) => got[i] === s)), DONE_DELAY_MS);
				},
			},
			false,
		);
		sc.run(sup);
	});
}

/** /core-replay [all|pass|hang|lost|cancel|resume] [live] — scripted job-bus scenarios for interactive testing. */
export function registerReplay(pi: ExtensionAPI) {
	pi.registerCommand(COMMAND_NAME, {
		description: COMMAND_DESCRIPTION,
		handler: async (args, ctx) => {
			const words = (args ?? "").trim().split(/\s+/).filter(Boolean);
			const live = words.includes(ARG_LIVE);
			const pick = words.find((w) => w !== ARG_LIVE) ?? ARG_ALL;
			const list = pick === ARG_ALL ? SCENARIOS : SCENARIOS.filter((s) => s.name === pick);
			if (list.length === 0) {
				ctx.ui.notify(unknownScenario(pick, SCENARIOS.map((s) => s.name)), NOTE_WARNING);
				return;
			}
			const forward = live
				? (ev: JobEvent) => pi.sendUserMessage(replayMessage(ev), { deliverAs: STEER })
				: undefined;

			const summary: string[] = [];
			for (const sc of list) {
				ctx.ui.setStatus(STATUS_KEY, statusLabel(sc.name));
				const lines: string[] = [scenarioHeader(sc.name, sc.desc)];
				const r = await runScenario(sc, (l) => lines.push(l), forward);
				lines.push(scenarioResult(r.ok, sc.expect, r.got));
				ctx.ui.notify(lines.join("\n"), r.ok ? NOTE_INFO : NOTE_ERROR);
				summary.push(summaryEntry(r.ok, sc.name));
			}
			ctx.ui.setStatus(STATUS_KEY, undefined);
			ctx.ui.notify(doneNote(live, summary), NOTE_INFO);
		},
	});
}
