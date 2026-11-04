import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { contentText, eventFrom, formatElapsed, isJobEvent } from "../job-event-data.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const EVENT = {
	type: "job_event" as const,
	job_id: "test-7",
	state: "timed_out" as const,
	step: "healthcheck",
	elapsed_s: 65,
	last_line: "Waiting for :8080",
	reversible: false,
	cancelable: true,
	options: ["cancel", "keep_waiting", "inspect_logs"],
};

test("job event validation preserves every model-facing field", () => {
	assert.equal(isJobEvent(EVENT), true);
	assert.deepEqual(eventFrom(undefined, JSON.stringify(EVENT)), EVENT);
	assert.equal(isJobEvent({ ...EVENT, options: [1] }), false);
	assert.equal(isJobEvent({ ...EVENT, elapsed_s: Number.NaN }), false);
});

test("job event extraction prefers structured details and falls back safely", () => {
	assert.equal(eventFrom(EVENT, "not json"), EVENT);
	assert.equal(eventFrom(undefined, "not json"), undefined);
	assert.equal(contentText([{ type: "text", text: JSON.stringify(EVENT) }]), JSON.stringify(EVENT));
	assert.equal(contentText([{ type: "image", data: "ignored" }]), "Job event details unavailable");
});

test("elapsed times stay compact and scannable", () => {
	assert.equal(formatElapsed(6), "6s");
	assert.equal(formatElapsed(65), "1m 5s");
	assert.equal(formatElapsed(3600), "1h");
	assert.equal(formatElapsed(3720), "1h 2m");
	assert.equal(formatElapsed(-4), "0s");
});

test("core steers a displayable custom message instead of a raw user block", () => {
	const source = readFileSync(resolve(ROOT, "core/index.ts"), "utf8");
	assert.match(source, /registerJobEventRenderer\(pi\)/);
	assert.match(source, /customType: JOB_EVENT_MESSAGE/);
	assert.match(source, /content: JSON\.stringify\(ev\)/);
	assert.match(source, /details: ev/);
	assert.match(source, /triggerTurn: true, deliverAs: "steer"/);
	assert.doesNotMatch(source, /sendUserMessage\(JSON\.stringify\(ev\)/);
});
