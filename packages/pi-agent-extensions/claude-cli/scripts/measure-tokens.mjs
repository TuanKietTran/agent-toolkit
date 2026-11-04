#!/usr/bin/env node
// Repeatable token measurement for Pi's claude-cli provider.
//
// Runs one fixed ~10 tool-call scenario against a throwaway repo through a real `pi`
// process (the provider under test is loaded with -e) and reads, per turn, the usage Pi
// receives from Claude CLI's stream-json `result` event: input, cache-creation,
// cache-read and output tokens. Also reads the provider's own per-spawn usage log
// (PI_CLAUDE_CLI_USAGE_LOG) for the number of internal API round trips per spawn.
//
//   node claude-cli/scripts/measure-tokens.mjs --label baseline --runs 2
//   node claude-cli/scripts/measure-tokens.mjs --ext /path/to/other/claude-cli/index.ts --label other
//
// Options:
//   --ext <file>       provider entry point (default: ../index.ts)
//   --model <id>       claude model id (default: claude-haiku-5-5)
//   --runs <n>         repetitions (default: 1)
//   --thinking <lvl>   Pi thinking level (default: off)
//   --label <text>     name used in the report
//   --env K=V          extra environment for pi (repeatable), e.g. a provider switch
//   --out <file>       also write the raw numbers as JSON
//   --full-tools       also load the bundled extensions that add Pi tools (browser, jobs, ...),
//                      to measure with a realistic, much larger tool set
//   --keep             keep the scratch repo (default: delete it)
//
// Needs `pi` and `claude` on PATH and a logged-in Claude CLI. Real API usage: a run is
// about ten short turns on the chosen model.
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

/** Extension entry points (relative to the package root) that register extra Pi tools. */
export const TOOL_EXTENSIONS = [
  "core/index.ts",
  "gc-assets/index.ts",
  "thinking-control.ts",
  "usage-roundrobin.ts",
  "remote-control.ts",
  "touchbar-usage/index.ts",
  "browser-control/index.ts",
];

export const SCENARIO_STEPS = [
  "List the files in the current directory with bash (ls -la).",
  "Read README.md with the read tool.",
  "Read src/calc.js with the read tool.",
  "Search the repo for the word TODO with bash (grep -rn TODO .).",
  "Run the program with bash: node src/main.js",
  "Fix the bug in src/calc.js with the edit tool: add() must return a + b.",
  "Run the tests with bash: node --test",
  "Create notes.txt with the write tool containing the single line: fixed add().",
  "Show the change with bash: git diff --stat",
  "Reply with a one-line summary of what you changed and the test result.",
];

export const SCENARIO_PROMPT = [
  "Work through these steps in order. Use exactly one tool call per step, do not skip, merge or add steps, and do not call tools for the last step.",
  ...SCENARIO_STEPS.map((step, i) => `${i + 1}. ${step}`),
].join("\n");

const FILES = {
  "README.md": "# calc-demo\n\nTiny calculator used for a token measurement.\n\nTODO: document the API.\n",
  "package.json": '{ "name": "calc-demo", "version": "1.0.0", "type": "module" }\n',
  "src/calc.js": "export function add(a, b) {\n  return a - b; // TODO: wrong operator\n}\n\nexport function mul(a, b) {\n  return a * b;\n}\n",
  "src/main.js": 'import { add, mul } from "./calc.js";\nconsole.log("add", add(2, 3));\nconsole.log("mul", mul(2, 3));\n',
  "calc.test.js": 'import test from "node:test";\nimport assert from "node:assert/strict";\nimport { add, mul } from "./src/calc.js";\ntest("add", () => assert.equal(add(2, 3), 5));\ntest("mul", () => assert.equal(mul(2, 3), 6));\n',
};

/** Did the scenario actually get done? Compares the scratch repo with what the steps ask for. */
export function verifyScratchRepo(dir) {
  const read = (rel) => (existsSync(join(dir, rel)) ? readFileSync(join(dir, rel), "utf8") : "");
  const { NODE_TEST_CONTEXT, ...env } = process.env; // a nested `node --test` must not think it is a subtest
  const tests = spawnSync("node", ["--test"], { cwd: dir, encoding: "utf8", env });
  return {
    editApplied: /return a \+ b/.test(read("src/calc.js")),
    notesWritten: read("notes.txt").includes("fixed add()"),
    testsPass: tests.status === 0,
  };
}

export function createScratchRepo() {
  const dir = mkdtempSync(join(tmpdir(), "pi-token-scenario-"));
  for (const [rel, body] of Object.entries(FILES)) {
    const path = join(dir, rel);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, body);
  }
  const git = (...args) => spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.invalid", ...args], { cwd: dir });
  git("init", "-q");
  git("add", "-A");
  git("commit", "-q", "-m", "init");
  return dir;
}

/** Fold Pi's `--mode json` event lines into one record per assistant turn. */
export function collectTurns(lines) {
  const turns = [];
  for (const line of lines) {
    let ev;
    try { ev = JSON.parse(line); } catch { continue; }
    if (ev.type !== "message_end" || ev.message?.role !== "assistant") continue;
    const m = ev.message;
    const u = m.usage ?? {};
    turns.push({
      tools: (m.content ?? []).filter((b) => b.type === "toolCall").map((b) => b.name),
      textChars: (m.content ?? []).filter((b) => b.type === "text").reduce((n, b) => n + b.text.length, 0),
      input: u.input ?? 0,
      cacheWrite: u.cacheWrite ?? 0,
      cacheRead: u.cacheRead ?? 0,
      output: u.output ?? 0,
      costUsd: u.cost?.total ?? 0,
      error: m.errorMessage,
    });
  }
  return turns;
}

export function totals(turns) {
  const sum = (key) => turns.reduce((n, t) => n + (t[key] ?? 0), 0);
  return {
    turns: turns.length,
    toolCalls: turns.reduce((n, t) => n + t.tools.length, 0),
    input: sum("input"),
    cacheWrite: sum("cacheWrite"),
    cacheRead: sum("cacheRead"),
    output: sum("output"),
    costUsd: sum("costUsd"),
    apiTurns: sum("apiTurns"),
    wallMs: sum("wallMs"),
  };
}

function parseArgs(argv) {
  const opts = { ext: resolve(here, "..", "index.ts"), model: "claude-haiku-5-5", runs: 1, thinking: "off", label: "run", env: {}, out: undefined, keep: false, fullTools: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === "--ext") opts.ext = resolve(next());
    else if (a === "--model") opts.model = next();
    else if (a === "--runs") opts.runs = Number(next());
    else if (a === "--thinking") opts.thinking = next();
    else if (a === "--label") opts.label = next();
    else if (a === "--out") opts.out = resolve(next());
    else if (a === "--keep") opts.keep = true;
    else if (a === "--full-tools") opts.fullTools = true;
    else if (a === "--env") { const [k, ...v] = next().split("="); opts.env[k] = v.join("="); }
    else throw new Error(`unknown option ${a}`);
  }
  return opts;
}

function cleanEnv(extra) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith("CLAUDE_CODE_") || key === "CLAUDECODE" || key === "CLAUDE_PID" || key === "CLAUDE_EFFORT") delete env[key];
  }
  return { ...env, ...extra };
}

function runOnce(opts, index) {
  const repo = createScratchRepo();
  const usageLog = join(repo, "..", `pi-token-usage-${process.pid}-${index}.jsonl`);
  return new Promise((resolveRun, reject) => {
    const args = [
      "--no-extensions", "-e", opts.ext,
      ...(opts.fullTools ? TOOL_EXTENSIONS.flatMap((rel) => ["-e", resolve(here, "..", "..", rel)]) : []),
      "--provider", "claude-cli", "--model", opts.model,
      "--thinking", opts.thinking,
      "--no-session", "--no-skills", "--no-context-files", "--no-prompt-templates",
      ...(opts.fullTools ? [] : ["--tools", "read,bash,edit,write"]),
      "--mode", "json", "-p", SCENARIO_PROMPT,
    ];
    const started = Date.now();
    const proc = spawn("pi", args, { cwd: repo, env: cleanEnv({ ...opts.env, PI_CLAUDE_CLI_USAGE_LOG: usageLog }), stdio: ["ignore", "pipe", "pipe"] });
    const turns = [];
    let buf = "";
    let stderr = "";
    let last = started;
    const feed = (lines) => {
      for (const t of collectTurns(lines)) {
        const now = Date.now();
        t.wallMs = now - last;
        last = now;
        turns.push(t);
      }
    };
    proc.stdout.on("data", (chunk) => {
      buf += chunk;
      const lines = buf.split("\n");
      buf = lines.pop() ?? "";
      feed(lines);
    });
    proc.stderr.on("data", (c) => { stderr += c; });
    const timer = setTimeout(() => proc.kill("SIGTERM"), 15 * 60_000);
    proc.on("error", reject);
    proc.on("close", (code) => {
      clearTimeout(timer);
      if (buf.trim()) feed([buf]);
      const spawns = existsSync(usageLog)
        ? readFileSync(usageLog, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l))
        : [];
      spawns.forEach((s, i) => { if (turns[i]) turns[i].apiTurns = s.apiTurns; });
      const sizes = spawns[0] ? { tools: spawns[0].tools, appendChars: spawns[0].appendChars, schemaChars: spawns[0].schemaChars, toolDefChars: spawns[0].toolDefChars } : undefined;
      rmSync(usageLog, { force: true });
      const outcome = verifyScratchRepo(repo);
      if (!opts.keep) rmSync(repo, { recursive: true, force: true });
      resolveRun({ code, turns, totals: totals(turns), outcome, sizes, stderr: stderr.slice(0, 500), repo: opts.keep ? repo : undefined });
    });
  });
}

const fmt = (n) => Math.round(n).toLocaleString("en-US");

export function renderReport(label, model, runs) {
  const out = [`### ${label} (${model}, ${runs.length} run${runs.length === 1 ? "" : "s"})`, ""];
  runs.forEach((run, i) => {
    const o = run.outcome;
    const outcome = o ? `; outcome: edit ${o.editApplied ? "ok" : "MISSING"}, notes ${o.notesWritten ? "ok" : "MISSING"}, tests ${o.testsPass ? "pass" : "FAIL"}` : "";
    out.push(`Run ${i + 1}: exit ${run.code}, ${run.totals.turns} turns, ${run.totals.toolCalls} tool calls${outcome}`, "");
    out.push("| # | tool call(s) | input | cache write | cache read | output | API round trips | wall s |", "| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |");
    run.turns.forEach((t, n) => {
      out.push(`| ${n + 1} | ${t.tools.join("+") || "(final text)"} | ${fmt(t.input)} | ${fmt(t.cacheWrite)} | ${fmt(t.cacheRead)} | ${fmt(t.output)} | ${t.apiTurns ?? "?"} | ${(t.wallMs / 1000).toFixed(1)} |`);
    });
    const T = run.totals;
    out.push(`| **total** | | **${fmt(T.input)}** | **${fmt(T.cacheWrite)}** | **${fmt(T.cacheRead)}** | **${fmt(T.output)}** | **${T.apiTurns}** | **${(T.wallMs / 1000).toFixed(0)}** |`, "");
  });
  const n = runs.length;
  const mean = (key) => runs.reduce((s, r) => s + r.totals[key], 0) / n;
  const toolCalls = mean("toolCalls");
  const billed = mean("input") + mean("cacheWrite") + mean("cacheRead") + mean("output");
  out.push(
    `Mean per run: input ${fmt(mean("input"))}, cache write ${fmt(mean("cacheWrite"))}, cache read ${fmt(mean("cacheRead"))}, output ${fmt(mean("output"))}, all tokens ${fmt(billed)}, cost $${mean("costUsd").toFixed(4)}, ${toolCalls.toFixed(1)} tool calls.`,
    `Per tool call: all tokens ${fmt(billed / Math.max(toolCalls, 1))}, fresh (input + cache write + output) ${fmt((mean("input") + mean("cacheWrite") + mean("output")) / Math.max(toolCalls, 1))}, cost $${(mean("costUsd") / Math.max(toolCalls, 1)).toFixed(4)}.`,
    "",
  );
  return out.join("\n");
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const runs = [];
  for (let i = 0; i < opts.runs; i++) {
    process.stderr.write(`[${opts.label}] run ${i + 1}/${opts.runs}...\n`);
    runs.push(await runOnce(opts, i));
  }
  process.stdout.write(`${renderReport(opts.label, opts.model, runs)}\n`);
  if (runs[0]?.sizes) process.stdout.write(`Per-spawn input sizes (chars): ${JSON.stringify(runs[0].sizes)}\n`);
  if (opts.out) writeFileSync(opts.out, `${JSON.stringify({ label: opts.label, model: opts.model, runs }, null, 2)}\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => { console.error(error); process.exit(1); });
}
