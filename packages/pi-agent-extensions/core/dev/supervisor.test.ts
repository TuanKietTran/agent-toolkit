import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import test from "node:test";
import type { JobEvent, JobRecord, KindConfig } from "../supervisor.ts";

// Use the same loader as Pi: Node's native TS stripping cannot transform the
// supervisor's constructor parameter properties.
const loaderPath = "./pi-root.mjs";
const { createLoader } = await import(loaderPath);
const loader = await createLoader(import.meta.url);
const { Supervisor }: typeof import("../supervisor.ts") = await loader.import("../supervisor.ts");

const kinds: Record<string, KindConfig> = {
  shell: { sla_s: 0.02, heartbeat_s: 0, class: "idempotent", cancelable: true },
  interactive: { sla_s: 0, heartbeat_s: 0, class: "idempotent", cancelable: true },
};
const options = { timed_out: ["cancel", "keep_waiting", "inspect_logs"] };
const command = (source: string) => `'${process.execPath.replaceAll("'", "'\\''")}' -e '${source}'`;

function harness(t: { after(fn: () => void): void }) {
  const events: JobEvent[] = [];
  const records: JobRecord[] = [];
  const sup = new Supervisor(kinds, options, {
    onEvent: (event) => events.push(event),
    onPersist: (rec) => records.push({ ...rec }),
  }, false);
  t.after(() => {
    for (const rec of sup.list()) {
      if (rec.state === "running" || rec.state === "timed_out") sup.cancel(rec.job_id);
    }
    sup.shutdown();
  });
  return { sup, events, records };
}

// Bounded event-driven wait: tests never infer completion from a timer.
async function waitFor(check: () => boolean) {
  const deadline = Date.now() + 4000;
  while (!check()) {
    assert.ok(Date.now() < deadline, "expected supervisor event did not arrive");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

test("SLA miss is advisory, cancellable, and followed by real completion", async (t) => {
  const { sup, events, records } = harness(t);
  const rec = sup.start("shell", command("setTimeout(() => process.exit(0), 150)"), tmpdir());
  await waitFor(() => events.some((e) => e.state === "timed_out"));
  assert.equal(events[0].cancelable, true);
  assert.ok(events[0].options.includes("keep_waiting"));
  assert.equal(sup.status(rec.job_id)?.state, "timed_out");
  await waitFor(() => events.some((e) => e.state === "completed"));
  assert.deepEqual(events.map((e) => e.state), ["timed_out", "completed"]);
  assert.equal(sup.status(rec.job_id)?.exit_code, 0);
  assert.equal(records.at(-1)?.state, "completed");
});

test("failure after an SLA warning is not swallowed", async (t) => {
  const { sup, events } = harness(t);
  sup.start("shell", command("setTimeout(() => process.exit(7), 150)"), tmpdir());
  await waitFor(() => events.some((e) => e.state === "failed"));
  assert.deepEqual(events.map((e) => e.state), ["timed_out", "failed"]);
});

test("interactive zero SLA emits no immediate warning and still reports exit", async (t) => {
  const { sup, events } = harness(t);
  const rec = sup.start("interactive", command("setTimeout(() => process.exit(0), 150)"), tmpdir());
  await waitFor(() => events.some((e) => e.state === "completed"));
  assert.deepEqual(events.map((e) => e.state), ["completed"]);
  assert.equal(sup.status(rec.job_id)?.exit_code, 0);
});

test("interactive jobs and overdue jobs remain cancellable", async (t) => {
  const { sup, events } = harness(t);
  const interactive = sup.start("interactive", command("setInterval(() => {}, 1000)"), tmpdir());
  assert.equal(sup.cancel(interactive.job_id), "cancelled");
  const overdue = sup.start("shell", command("setInterval(() => {}, 1000)"), tmpdir());
  await waitFor(() => events.some((e) => e.job_id === overdue.job_id && e.state === "timed_out"));
  assert.equal(sup.cancel(overdue.job_id), "cancelled");
  assert.equal(sup.status(overdue.job_id)?.state, "cancelled");
});

test("restoring an overdue record checks the process instead of treating it as terminal", (t) => {
  const { sup, events } = harness(t);
  sup.restore([{
    job_id: "shell-9", kind: "shell", command: "ignored", cwd: tmpdir(),
    state: "timed_out", pid: process.pid, started_at: Date.now(), sla_s: 60,
    heartbeat_s: 0, reversible: true, cancelable: true,
  }]);
  assert.equal(events[0]?.state, "lost");
  assert.match(events[0]?.last_line, /still alive but unattached/);
});

test("declarative policy and renderer distinguish advisory deadlines from hard timeouts", () => {
  const commands = readFileSync(new URL("../commands.md", import.meta.url), "utf8");
  const blocks = [...commands.matchAll(/```json\s*\n([\s\S]*?)```/g)].map((m) => JSON.parse(m[1]));
  const config = blocks.find((b) => b.interactive);
  assert.deepEqual(config.interactive, kinds.interactive);
  const ui = readFileSync(new URL("../job-event-ui.ts", import.meta.url), "utf8");
  assert.match(ui, /timed_out: "SLA EXCEEDED · STILL RUNNING"/);
  const rules = readFileSync(new URL("../rules.md", import.meta.url), "utf8");
  assert.match(rules, /keep_waiting` needs no tool call/);
});
