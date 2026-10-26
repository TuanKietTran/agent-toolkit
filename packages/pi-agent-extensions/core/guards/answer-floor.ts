/**
 * answer-floor — keeps the model's reply from being cut off, and finishes it when it is.
 *
 * Companion to context-guard.ts, which trims oversized *tool results*. This one
 * protects the opposite side: the answer budget.
 *
 * pi sizes every request with (ai/src/api/simple-options.ts):
 *
 *     available = model.contextWindow - estimatedContextTokens - 4096
 *     max_tokens = min(model.maxTokens, max(1, available))
 *
 * CONTEXT_SAFETY_TOKENS is a hardcoded 4096 and MIN_MAX_TOKENS is 1, so on a
 * small local window the budget collapses silently rather than erroring. That is
 * what cut session 01a0559f off mid-thought: an 8192-token window with 4024
 * tokens of context yielded max_tokens = 8192 - 4024 - 4096 = 72, and the reply
 * stopped after exactly 72 tokens with finish_reason "length".
 *
 * Two defences, in order:
 *
 *  1. Before the request, restore a usable floor under max_tokens.
 *  2. After a reply that still stopped on "length", fix it rather than report it:
 *     compact if the budget was squeezed, then tell the agent to carry on. A
 *     truncated reply is recoverable — the partial text is still in the session,
 *     so the model can resume from it — and making the user notice, diagnose and
 *     type /compact is work the extension already has the information to do.
 *
 * Raising the floor is safe: llama.cpp bounds generation by its own n_ctx and
 * stops cleanly, so an over-large max_tokens cannot overflow the server. Only the
 * prompt can do that, and this hook does not touch the prompt.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { limits, prompt } from "../md.ts";

import { PI_EVENT } from "../events.ts";

// --- Constants: every local literal lives here. ---

const CONTEXTS_FILE = "contexts.md";
const RULES_FILE = "rules.md";
const LIMITS_NAME = "answer-floor";
const CONTINUE_HEADING = "continue-prompt";
const ROLE_ASSISTANT = "assistant";
const STOP_LENGTH = "length";
const DELIVER_FOLLOW_UP = "followUp";
const NOTE_INFO = "info";
const NOTE_ERROR = "error";
const NOTE_CONTINUING = "Reply hit the output cap — continuing it.";
const noteGaveUp = (max: number) =>
	`Reply hit the output cap ${max} times in a row; not resuming again. ` +
	`Widen the model's context window or lower what you are asking for in one go.`;
const noteSqueezed = (available: number, wanted: number) =>
	`Reply was cut off: only ${Math.max(0, available)} of ${wanted} output ` +
	`tokens were left. Compacting, then continuing.`;
const noteCompactFailed = (message: string) => `Compaction failed (${message}); continuing anyway.`;

// Limits live in contexts.md, the resume prompt in rules.md.
const cfg = limits<{ floor_tokens: number; safety_tokens: number; max_auto_continues: number }>(
	CONTEXTS_FILE,
	LIMITS_NAME,
);

/** Enough to finish a reasoning block and the answer that follows it. */
const FLOOR_TOKENS = cfg.floor_tokens;

/** pi's hardcoded CONTEXT_SAFETY_TOKENS, mirrored so we can predict the squeeze. */
const SAFETY_TOKENS = cfg.safety_tokens;

/** The fields the various provider payloads use for the output cap. */
const CAP_FIELDS = ["max_tokens", "max_completion_tokens", "maxOutputTokens"] as const;

/**
 * A model that keeps stopping on "length" would otherwise be resumed forever.
 * Three recoveries is enough for a genuinely long answer; past that the cause is
 * something a retry will not fix.
 */
const MAX_AUTO_CONTINUES = cfg.max_auto_continues;

const CONTINUE_PROMPT = prompt(RULES_FILE, CONTINUE_HEADING);

let consecutiveContinues = 0;

interface ModelShape {
	contextWindow?: number;
	maxTokens?: number;
}

/** Tokens the next reply would get, by pi's own arithmetic. */
function budgetAhead(ctx: ExtensionContext): { available: number; wanted: number } | undefined {
	const model = ctx.model as ModelShape | undefined;
	if (!model?.contextWindow || !model.maxTokens) return undefined;
	const used = ctx.getContextUsage()?.tokens ?? 0;
	return { available: model.contextWindow - used - SAFETY_TOKENS, wanted: model.maxTokens };
}

export default function (pi: ExtensionAPI) {
	pi.on(PI_EVENT.BEFORE_PROVIDER_REQUEST, (event, ctx) => {
		const payload = event.payload as Record<string, unknown> | undefined;
		if (!payload) return;

		// Never ask for more than the model is declared to produce.
		const ceiling = (ctx.model as ModelShape | undefined)?.maxTokens;
		const floor = ceiling && ceiling > 0 ? Math.min(FLOOR_TOKENS, ceiling) : FLOOR_TOKENS;

		let patched: Record<string, unknown> | undefined;
		for (const field of CAP_FIELDS) {
			const current = payload[field];
			if (typeof current !== "number" || current >= floor) continue;
			patched ??= { ...payload };
			patched[field] = floor;
		}
		return patched;
	});

	pi.on(PI_EVENT.MESSAGE_END, (event, ctx) => {
		const message = event.message as { role?: string; stopReason?: string } | undefined;
		if (message?.role !== ROLE_ASSISTANT) return;

		if (message.stopReason !== STOP_LENGTH) {
			consecutiveContinues = 0;
			return;
		}

		if (consecutiveContinues >= MAX_AUTO_CONTINUES) {
			consecutiveContinues = 0;
			if (ctx.hasUI) {
				ctx.ui.notify(noteGaveUp(MAX_AUTO_CONTINUES), NOTE_ERROR);
			}
			return;
		}
		consecutiveContinues++;

		const resume = () => pi.sendUserMessage(CONTINUE_PROMPT, { deliverAs: DELIVER_FOLLOW_UP });

		// Squeezed budget or simply a long answer? Only the first needs compaction,
		// and compacting a nearly-empty context would throw away history for nothing.
		const budget = budgetAhead(ctx);
		if (!budget || budget.available >= budget.wanted) {
			if (ctx.hasUI) ctx.ui.notify(NOTE_CONTINUING, NOTE_INFO);
			resume();
			return;
		}

		if (ctx.hasUI) {
			ctx.ui.notify(noteSqueezed(budget.available, budget.wanted), NOTE_INFO);
		}
		ctx.compact({
			onComplete: resume,
			onError: (error: Error) => {
				// Compaction failing is not fatal here — the reply is still worth
				// finishing on whatever budget remains.
				if (ctx.hasUI) ctx.ui.notify(noteCompactFailed(error.message), NOTE_ERROR);
				resume();
			},
		});
	});
}
