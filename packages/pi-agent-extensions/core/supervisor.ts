import { spawn, type ChildProcess } from "node:child_process";

export type JobState =
	| "queued"
	| "running"
	| "progress"
	| "completed"
	| "failed"
	| "timed_out"
	| "lost"
	| "cancelled";

export interface KindConfig {
	sla_s: number;
	heartbeat_s: number;
	class: "idempotent" | "reversible" | "compensable" | "irreversible";
	cancelable: boolean;
}

export interface JobEvent {
	type: "job_event";
	job_id: string;
	state: JobState;
	step: string;
	elapsed_s: number;
	last_line: string;
	reversible: boolean;
	cancelable: boolean;
	options: string[];
}

export interface JobRecord {
	job_id: string;
	kind: string;
	command: string;
	cwd: string;
	state: JobState;
	pid?: number;
	started_at: number;
	sla_s: number;
	heartbeat_s: number;
	reversible: boolean;
	cancelable: boolean;
	exit_code?: number | null;
}

interface LiveJob {
	rec: JobRecord;
	child?: ChildProcess;
	lines: string[];
	partial: string;
	lastBeat: number;
	timers: NodeJS.Timeout[];
	terminal: boolean;
}

// --- Constants: every local literal lives here. ---

const RING_MAX = 500;
const MAX_TAIL = 200;
const MAX_LOG_BYTES = 12000;
const LAST_LINE_MAX = 200;
const KILL_GRACE_MS = 3000;
const SLA_STEP = "sla";
export const SHELL = "/bin/sh";
const SHELL_FLAG = "-c";
const ENCODING = "utf8";
const LINE_BREAK = "\n";
const SIGNAL_PROBE = 0;
const SIGTERM = "SIGTERM";
const SIGKILL = "SIGKILL";
const EVENT_TYPE = "job_event";
const CLASS_IDEMPOTENT = "idempotent";
const CLASS_REVERSIBLE = "reversible";
const CLASS_IRREVERSIBLE = "irreversible";
const QUEUED = "queued";
const RUNNING = "running";
const COMPLETED = "completed";
const FAILED = "failed";
const TIMED_OUT = "timed_out";
const LOST = "lost";
const CANCELLED = "cancelled";
// timed_out is an advisory SLA miss; the child is still supervised until it exits.
const TERMINAL: JobState[] = [COMPLETED, FAILED, LOST, CANCELLED];

// Messages
const NOTE_RESUMED_ALIVE = "resumed: process still alive but unattached";
const NOTE_RESUMED_GONE = "resumed: process gone";
const NOTE_HEARTBEAT = "heartbeat missed";
const RESULT_CANCELLED = "cancelled";
const unknownKind = (kind: string, known: string[]) => `Unknown kind '${kind}'. Known: ${known.join(", ")}`;
const irreversibleDisabled = (kind: string) =>
	`Kind '${kind}' is irreversible and disabled. Ask the user to confirm, set jobs.allowIrreversible=true in ~/.pi/agent/settings.json, and run /reload.`;
const unknownJob = (id: string) => `Unknown job ${id}`;
const notCancelable = (id: string) => `Job ${id} is not cancelable`;
const alreadyState = (state: JobState) => `already ${state}`;
const spawnError = (message: string) => `spawn error: ${message}`;
const killedBySignal = (sig: string) => `killed by signal ${sig}`;
const exitCode = (code: number | null) => `exit ${code}`;
const hostLine = (note: string) => `[host] ${note}`;

export interface SupervisorHooks {
	/** Called once per state change worth telling the model about. */
	onEvent(ev: JobEvent): void;
	/** Called on every record change so the host can persist. */
	onPersist(rec: JobRecord): void;
	/** Operator-only live output (never fed to the model). */
	onOutput?(job_id: string, line: string): void;
}

export class Supervisor {
	private jobs = new Map<string, LiveJob>();
	private seq = 0;

	constructor(
		private kinds: Record<string, KindConfig>,
		private options: Record<string, string[]>,
		private hooks: SupervisorHooks,
		private allowIrreversible: boolean,
	) {}

	setConfig(kinds: Record<string, KindConfig>, options: Record<string, string[]>) {
		this.kinds = kinds;
		this.options = options;
	}

	kindNames(): string[] {
		return Object.keys(this.kinds);
	}

	/** Restore records from a resumed session; live processes are unknown so running ones become lost. */
	restore(recs: JobRecord[]) {
		for (const rec of recs) {
			if (this.jobs.has(rec.job_id)) continue;
			const n = Number(rec.job_id.split("-").pop());
			if (Number.isFinite(n)) this.seq = Math.max(this.seq, n);
			const job: LiveJob = { rec, lines: [], partial: "", lastBeat: Date.now(), timers: [], terminal: TERMINAL.includes(rec.state) };
			this.jobs.set(rec.job_id, job);
			if (!job.terminal) {
				let alive = false;
				if (rec.pid) {
					try {
						process.kill(rec.pid, SIGNAL_PROBE);
						alive = true;
					} catch {}
				}
				// Cannot reattach to stdio; treat as lost so the model decides.
				this.finish(job, LOST, alive ? NOTE_RESUMED_ALIVE : NOTE_RESUMED_GONE);
			}
		}
	}

	start(kind: string, command: string, cwd: string): JobRecord {
		const cfg = this.kinds[kind];
		if (!cfg) throw new Error(unknownKind(kind, this.kindNames()));
		if (cfg.class === CLASS_IRREVERSIBLE && !this.allowIrreversible) throw new Error(irreversibleDisabled(kind));
		const job_id = `${kind}-${++this.seq}`;
		const rec: JobRecord = {
			job_id,
			kind,
			command,
			cwd,
			state: QUEUED,
			started_at: Date.now(),
			sla_s: cfg.sla_s,
			heartbeat_s: cfg.heartbeat_s,
			reversible: cfg.class === CLASS_IDEMPOTENT || cfg.class === CLASS_REVERSIBLE,
			cancelable: cfg.cancelable,
		};
		const job: LiveJob = { rec, lines: [], partial: "", lastBeat: Date.now(), timers: [], terminal: false };
		this.jobs.set(job_id, job);

		const child = spawn(SHELL, [SHELL_FLAG, command], { cwd, detached: true, stdio: ["ignore", "pipe", "pipe"] });
		job.child = child;
		rec.pid = child.pid;
		rec.state = RUNNING;
		this.hooks.onPersist(rec);

		const onData = (buf: Buffer) => {
			job.lastBeat = Date.now();
			job.partial += buf.toString(ENCODING);
			const parts = job.partial.split(LINE_BREAK);
			job.partial = parts.pop() ?? "";
			for (const line of parts) this.pushLine(job, line);
		};
		child.stdout?.on("data", onData);
		child.stderr?.on("data", onData);
		child.on("error", (e) => this.finish(job, FAILED, spawnError(e.message)));
		child.on("close", (code, sig) => {
			if (job.partial) this.pushLine(job, job.partial);
			job.partial = "";
			rec.exit_code = code;
			if (job.terminal) return;
			if (code === 0) this.finish(job, COMPLETED);
			else if (sig && code === null) this.finish(job, LOST, killedBySignal(sig));
			else this.finish(job, FAILED, exitCode(code));
		});

		// Interactive hosts and attached agents have no expected completion deadline.
		// Zero disables only the SLA warning, not exit/cancel/heartbeat supervision.
		if (cfg.sla_s > 0) {
			job.timers.push(
				setTimeout(() => {
					if (job.terminal) return;
					// SLA miss: report, do not kill. The model chooses cancel / keep_waiting.
					this.emit(job, TIMED_OUT, SLA_STEP);
				}, cfg.sla_s * 1000),
			);
		}
		if (cfg.heartbeat_s > 0) {
			job.timers.push(
				setInterval(() => {
					if (job.terminal) return;
					if (Date.now() - job.lastBeat > cfg.heartbeat_s * 2000) {
						this.finish(job, LOST, NOTE_HEARTBEAT);
						// Unattended policy: auto-cancel on lost.
						this.kill(job);
					}
				}, cfg.heartbeat_s * 1000),
			);
		}
		return rec;
	}

	status(job_id: string): (JobRecord & { elapsed_s: number; last_line: string }) | undefined {
		const j = this.jobs.get(job_id);
		if (!j) return undefined;
		return { ...j.rec, elapsed_s: this.elapsed(j), last_line: this.last(j) };
	}

	list(): JobRecord[] {
		return [...this.jobs.values()].map((j) => j.rec);
	}

	logs(job_id: string, tail: number): string[] | undefined {
		const j = this.jobs.get(job_id);
		if (!j) return undefined;
		const lines = j.lines.slice(-Math.max(1, Math.min(tail, MAX_TAIL)));
		let total = 0;
		const kept: string[] = [];
		for (let i = lines.length - 1; i >= 0; i--) {
			const line = lines[i]!.slice(0, LAST_LINE_MAX);
			const size = Buffer.byteLength(line, ENCODING) + 1;
			if (kept.length > 0 && total + size > MAX_LOG_BYTES) break;
			kept.unshift(line);
			total += size;
		}
		return kept;
	}

	cancel(job_id: string): string {
		const j = this.jobs.get(job_id);
		if (!j) throw new Error(unknownJob(job_id));
		if (j.terminal) return alreadyState(j.rec.state);
		if (!j.rec.cancelable) throw new Error(notCancelable(job_id));
		this.finish(j, CANCELLED);
		this.kill(j);
		return RESULT_CANCELLED;
	}

	shutdown() {
		for (const j of this.jobs.values()) {
			for (const t of j.timers) {
				clearTimeout(t);
				clearInterval(t);
			}
			j.timers = [];
		}
	}

	private kill(j: LiveJob) {
		const pid = j.child?.pid ?? j.rec.pid;
		if (!pid) return;
		try {
			process.kill(-pid, SIGTERM);
		} catch {}
		setTimeout(() => {
			try {
				process.kill(-pid, SIGKILL);
			} catch {}
		}, KILL_GRACE_MS).unref();
	}

	private pushLine(j: LiveJob, line: string) {
		j.lines.push(line);
		if (j.lines.length > RING_MAX) j.lines.shift();
		this.hooks.onOutput?.(j.rec.job_id, line);
	}

	private elapsed(j: LiveJob) {
		return Math.round((Date.now() - j.rec.started_at) / 1000);
	}

	private last(j: LiveJob) {
		return (j.lines[j.lines.length - 1] ?? "").slice(0, LAST_LINE_MAX);
	}

	private finish(j: LiveJob, state: JobState, note?: string) {
		if (j.terminal) return;
		j.terminal = true;
		for (const t of j.timers) {
			clearTimeout(t);
			clearInterval(t);
		}
		j.timers = [];
		j.rec.state = state;
		if (note) this.pushLine(j, hostLine(note));
		this.emit(j, state, note ?? "");
	}

	private emit(j: LiveJob, state: JobState, step: string) {
		if (state === TIMED_OUT) j.rec.state = TIMED_OUT;
		this.hooks.onPersist(j.rec);
		this.hooks.onEvent({
			type: EVENT_TYPE,
			job_id: j.rec.job_id,
			state,
			step,
			elapsed_s: this.elapsed(j),
			last_line: this.last(j),
			reversible: j.rec.reversible,
			cancelable: j.rec.cancelable && !j.terminal,
			options: this.options[state] ?? [],
		});
	}
}
