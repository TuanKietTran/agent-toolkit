import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import { Box, Text, stripTerminalSequences, visibleWidth, wrapTextWithAnsi, type Component } from "@earendil-works/pi-tui";
import { contentText, eventFrom, formatElapsed } from "./job-event-data.ts";
import type { JobEvent, JobState } from "./supervisor.ts";

// --- Constants: every local literal lives here. ---

export const JOB_EVENT_MESSAGE = "core-job-event";

const ICON_BY_STATE: Record<JobState, string> = {
	queued: "○",
	running: "●",
	progress: "↻",
	completed: "✓",
	failed: "×",
	timed_out: "!",
	lost: "?",
	cancelled: "■",
};

const LABEL_BY_STATE: Record<JobState, string> = {
	queued: "QUEUED",
	running: "RUNNING",
	progress: "PROGRESS",
	completed: "COMPLETED",
	failed: "FAILED",
	timed_out: "SLA EXCEEDED · STILL RUNNING",
	lost: "LOST",
	cancelled: "CANCELLED",
};

const COLOR_BY_STATE = {
	queued: "muted",
	running: "accent",
	progress: "accent",
	completed: "success",
	failed: "error",
	timed_out: "warning",
	lost: "error",
	cancelled: "muted",
} as const;

const BACKGROUND_BY_STATE = {
	queued: "toolPendingBg",
	running: "toolPendingBg",
	progress: "toolPendingBg",
	completed: "toolSuccessBg",
	failed: "toolErrorBg",
	timed_out: "customMessageBg",
	lost: "toolErrorBg",
	cancelled: "customMessageBg",
} as const;

const JOB_LABEL = "JOB";
const LAST_LABEL = "Last";
const STEP_LABEL = "Step";
const ACTIONS_LABEL = "Actions";
const FALLBACK_TITLE = "JOB EVENT";
const EMPTY_SUMMARY = "(no output)";
const NO_ACTIONS = "none";
const REVERSIBLE = "reversible";
const IRREVERSIBLE = "irreversible";
const CANCELABLE = "cancelable";
const NOT_CANCELABLE = "not cancelable";
const CONTENT_FALLBACK = "Job event details unavailable";
const ANSI_PATTERN = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;

function plainText(value: string): string {
	return stripTerminalSequences(value).replace(ANSI_PATTERN, " ").trim();
}

function labeledLines(label: string, value: string, width: number, theme: Theme): string[] {
	const prefix = `${theme.fg("dim", label)}  `;
	const prefixWidth = visibleWidth(prefix);
	if (width <= prefixWidth) return [...wrapTextWithAnsi(prefix.trimEnd(), width), ...wrapTextWithAnsi(value, width)];
	const wrapped = wrapTextWithAnsi(value, Math.max(1, width - prefixWidth));
	return wrapped.map((line, index) => `${index === 0 ? prefix : " ".repeat(prefixWidth)}${line}`);
}

function eventLines(event: JobEvent, theme: Theme, width: number): string[] {
	const color = COLOR_BY_STATE[event.state];
	const status = theme.fg(color, theme.bold(`${ICON_BY_STATE[event.state]} ${LABEL_BY_STATE[event.state]}`));
	const identity = theme.fg("muted", `${event.job_id} · ${formatElapsed(event.elapsed_s)}`);
	const summary = plainText(event.last_line) || EMPTY_SUMMARY;
	const reverse = event.reversible
		? theme.fg("success", `↶ ${REVERSIBLE}`)
		: theme.fg("warning", `◆ ${IRREVERSIBLE}`);
	const cancel = event.cancelable
		? theme.fg("accent", `■ ${CANCELABLE}`)
		: theme.fg("dim", `□ ${NOT_CANCELABLE}`);
	const options = event.options.length
		? event.options.map((option) => theme.fg("accent", `[${plainText(option)}]`)).join(" ")
		: theme.fg("dim", NO_ACTIONS);
	const lines = wrapTextWithAnsi(`${theme.fg("dim", JOB_LABEL)}  ${status}  ${identity}`, width);
	lines.push(...labeledLines(LAST_LABEL, summary, width, theme));
	if (event.step) lines.push(...labeledLines(STEP_LABEL, plainText(event.step), width, theme));
	lines.push(...wrapTextWithAnsi(`${reverse}   ${cancel}`, width));
	lines.push(...labeledLines(ACTIONS_LABEL, options, width, theme));
	return lines;
}

class JobEventBody implements Component {
	constructor(private readonly event: JobEvent, private readonly theme: Theme) {}

	render(width: number): string[] {
		return eventLines(this.event, this.theme, width);
	}

	invalidate(): void {}
}

export function renderJobEvent(
	message: { content: unknown; details?: unknown },
	outputPad: number,
	theme: Theme,
): Box {
	const event = eventFrom(message.details, message.content);
	const box = new Box(outputPad, 1, (line) => theme.bg(event ? BACKGROUND_BY_STATE[event.state] : "customMessageBg", line));
	if (event) {
		box.addChild(new JobEventBody(event, theme));
	} else {
		const title = theme.fg("warning", theme.bold(FALLBACK_TITLE));
		box.addChild(new Text(`${title}\n${plainText(contentText(message.content)) || CONTENT_FALLBACK}`, 0, 0));
	}
	return box;
}

export function registerJobEventRenderer(pi: ExtensionAPI): void {
	pi.registerMessageRenderer(JOB_EVENT_MESSAGE, (message, { outputPad }, theme) =>
		renderJobEvent(message, outputPad, theme));
}
