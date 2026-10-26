import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { scanCategories, sweep, type GcConfig } from "../scanner.ts";

// --- Constants: every local literal lives here. ---

const DAY_MS = 86_400_000;
const COMMAND_NAME = "gc-replay";
const COMMAND_DESCRIPTION = "Replay gc-assets scan/sweep on a scratch directory and print PASS/FAIL";
const SCRATCH_PREFIX = "gc-replay-";
const FILE_BODY = "x".repeat(100);
const FILE_BYTES = 100;
const STALE_DAYS = 30;
const FRESH_DAYS = 0;
const AGE_DAYS = 7;
const ENTRY_AUTO = "auto";
const ENTRY_KEEP = "keep";
const ENTRY_CONFIRM = "confirm";
const SWEEP_NEVER = "never";
const FILE_AUTO_OLD = "auto/old.log";
const FILE_AUTO_NEW = "auto/new.log";
const FILE_KEEP_OLD = "keep/old.db";
const FILE_CONFIRM_OLD = "confirm/old.jsonl";
const NOTE_INFO = "info";
const NOTE_ERROR = "error";
const HEADER = "▶ gc-replay";
const RESULT_PASS = "✔ PASS";
const RESULT_FAIL = "✘ FAIL";
const CHECK_AUTO = "auto: 2 files, 1 stale";
const CHECK_KEEP = "never: counted, 0 stale";
const CHECK_CONFIRM = "confirm: 1 stale";
const CHECK_SWEPT = "sweep removed 1 file, 100B";
const CHECK_OLD_GONE = "old auto file gone";
const CHECK_FRESH_KEPT = "fresh auto file kept";
const CHECK_NEVER_KEPT = "never-category file kept";
const CHECK_CONFIRM_KEPT = "confirm-category file kept (not targeted)";
const checkLine = (name: string, pass: boolean) => `  ${pass ? "✔" : "✘"} ${name}`;

async function touch(file: string, ageDays: number) {
	await fs.mkdir(path.dirname(file), { recursive: true });
	await fs.writeFile(file, FILE_BODY);
	const t = new Date(Date.now() - ageDays * DAY_MS);
	await fs.utimes(file, t, t);
}

/** /gc-replay — scan + sweep against a scratch dir. Never touches real pi assets or shared state. */
export function registerReplay(pi: ExtensionAPI) {
	pi.registerCommand(COMMAND_NAME, {
		description: COMMAND_DESCRIPTION,
		handler: async (_args, ctx) => {
			const dir = await fs.mkdtemp(path.join(os.tmpdir(), SCRATCH_PREFIX));
			const checks: [string, boolean][] = [];
			try {
				await touch(path.join(dir, FILE_AUTO_OLD), STALE_DAYS);
				await touch(path.join(dir, FILE_AUTO_NEW), FRESH_DAYS);
				await touch(path.join(dir, FILE_KEEP_OLD), STALE_DAYS);
				await touch(path.join(dir, FILE_CONFIRM_OLD), STALE_DAYS);
				const cfg: GcConfig = {
					tick_ms: 60_000,
					max_files: 50_000,
					age_days: AGE_DAYS,
					categories: [
						{ id: ENTRY_AUTO, label: ENTRY_AUTO, sweep: ENTRY_AUTO, roots: [path.join(dir, ENTRY_AUTO)] },
						{ id: ENTRY_KEEP, label: ENTRY_KEEP, sweep: SWEEP_NEVER, roots: [path.join(dir, ENTRY_KEEP)] },
						{ id: ENTRY_CONFIRM, label: ENTRY_CONFIRM, sweep: ENTRY_CONFIRM, roots: [path.join(dir, ENTRY_CONFIRM)] },
					],
				};
				const cats = await scanCategories(cfg, AGE_DAYS);
				const by = (id: string) => cats.find((c) => c.id === id)!;
				checks.push([CHECK_AUTO, by(ENTRY_AUTO).files === 2 && by(ENTRY_AUTO).staleFiles === 1]);
				checks.push([CHECK_KEEP, by(ENTRY_KEEP).files === 1 && by(ENTRY_KEEP).staleFiles === 0]);
				checks.push([CHECK_CONFIRM, by(ENTRY_CONFIRM).staleFiles === 1]);

				const done = await sweep(cats.filter((c) => c.sweep === ENTRY_AUTO), AGE_DAYS);
				const exists = (p: string) => fs.access(path.join(dir, p)).then(() => true, () => false);
				checks.push([CHECK_SWEPT, done.files === 1 && done.bytes === FILE_BYTES]);
				checks.push([CHECK_OLD_GONE, !(await exists(FILE_AUTO_OLD))]);
				checks.push([CHECK_FRESH_KEPT, await exists(FILE_AUTO_NEW)]);
				checks.push([CHECK_NEVER_KEPT, await exists(FILE_KEEP_OLD)]);
				checks.push([CHECK_CONFIRM_KEPT, await exists(FILE_CONFIRM_OLD)]);
			} finally {
				await fs.rm(dir, { recursive: true, force: true });
			}
			const ok = checks.every(([, pass]) => pass);
			ctx.ui.notify(
				[HEADER, ...checks.map(([n, pass]) => checkLine(n, pass)), ok ? RESULT_PASS : RESULT_FAIL].join("\n"),
				ok ? NOTE_INFO : NOTE_ERROR,
			);
		},
	});
}
