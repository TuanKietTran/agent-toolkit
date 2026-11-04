import type { JobEvent, JobState } from "./supervisor.ts";

const JOB_STATES = new Set<JobState>([
	"queued",
	"running",
	"progress",
	"completed",
	"failed",
	"timed_out",
	"lost",
	"cancelled",
]);
const CONTENT_FALLBACK = "Job event details unavailable";

function isJobState(value: unknown): value is JobState {
	return typeof value === "string" && JOB_STATES.has(value as JobState);
}

export function isJobEvent(value: unknown): value is JobEvent {
	if (!value || typeof value !== "object") return false;
	const event = value as Partial<JobEvent>;
	return event.type === "job_event"
		&& typeof event.job_id === "string"
		&& isJobState(event.state)
		&& typeof event.step === "string"
		&& typeof event.elapsed_s === "number"
		&& Number.isFinite(event.elapsed_s)
		&& typeof event.last_line === "string"
		&& typeof event.reversible === "boolean"
		&& typeof event.cancelable === "boolean"
		&& Array.isArray(event.options)
		&& event.options.every((option) => typeof option === "string");
}

export function contentText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return CONTENT_FALLBACK;
	const text = content
		.filter((part): part is { type: "text"; text: string } =>
			Boolean(part)
			&& typeof part === "object"
			&& "type" in part
			&& part.type === "text"
			&& "text" in part
			&& typeof part.text === "string")
		.map((part) => part.text)
		.join("\n");
	return text || CONTENT_FALLBACK;
}

export function eventFrom(details: unknown, content: unknown): JobEvent | undefined {
	if (isJobEvent(details)) return details;
	try {
		const parsed: unknown = JSON.parse(contentText(content));
		return isJobEvent(parsed) ? parsed : undefined;
	} catch {
		return undefined;
	}
}

export function formatElapsed(seconds: number): string {
	const total = Math.max(0, Math.round(seconds));
	if (total < 60) return `${total}s`;
	const minutes = Math.floor(total / 60);
	const remainder = total % 60;
	if (minutes < 60) return remainder ? `${minutes}m ${remainder}s` : `${minutes}m`;
	const hours = Math.floor(minutes / 60);
	const minuteRemainder = minutes % 60;
	return minuteRemainder ? `${hours}h ${minuteRemainder}m` : `${hours}h`;
}
