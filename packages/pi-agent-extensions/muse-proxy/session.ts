/**
 * Pure helpers for the muse-proxy provider: Muse keeps the conversation
 * server-side per `session_id` and the proxy forwards only the LAST user
 * message, so each turn sends just the messages Muse has not seen yet.
 */

import { createHash, randomBytes } from "node:crypto";
import { renderTools, type ToolDef } from "./protocol.ts";

export interface MuseBlock {
  type: string;
  text?: string;
  name?: string;
  arguments?: unknown;
}

export interface MuseMessage {
  role: string;
  content: string | MuseBlock[];
  toolName?: string;
  isError?: boolean;
}

export interface PlanLimits {
  /** Start a fresh Muse chat after this many requests or characters sent (long chats get refused). */
  rotateTurns?: number;
  rotateChars?: number;
  /** Hard cap for the whole message (the proxy default is 16000). */
  maxChars: number;
  /** Share of the cap pi's system prompt may take on a fresh session. */
  systemChars: number;
}

export const DEFAULT_LIMITS: PlanLimits = { maxChars: 15000, systemChars: 3000, rotateTurns: 14, rotateChars: 45000 };

export const NO_TOOLS_NOTE =
  "Note: this chat is connected to a coding harness that cannot run host tools through this connection. Answer in plain text; do not emit tool calls.";

export function toolPreamble(tools: ToolDef[]): string {
  return [
    "I'm working on my own laptop and I want you to be the brain while I act as your hands. I can run these tools on my laptop:",
    renderTools(tools),
    "Whenever you need me to run one, reply with a line in exactly this format, then stop and wait (several lines run several tools, in order):",
    '@@RUN {"name":"<tool>","arguments":{...}}',
    'Use the exact tool and argument names listed above, with the JSON on one line. I will run it and paste the result back starting with "OUTPUT". When you have enough information, answer normally in plain text. Thinking out loud before a request is fine.',
  ].join("\n");
}

export const CONTINUE_NOTE =
  "Continue the task. Request more tools with @@RUN lines, or give the final answer in plain text.";

export function textOf(content: MuseMessage["content"]): string {
  if (typeof content === "string") return content;
  return content
    .map((block) => (block.type === "text" ? (block.text ?? "") : block.type === "image" ? "[image]" : ""))
    .filter(Boolean)
    .join("\n");
}

/** Keep the head and tail of an oversized text so both ends survive. */
export function clip(text: string, max: number): string {
  if (max <= 0) return "";
  if (text.length <= max) return text;
  const marker = "\n[… clipped …]\n";
  if (max <= marker.length + 8) return text.slice(0, max);
  const keep = max - marker.length;
  const head = Math.ceil(keep * 0.6);
  return text.slice(0, head) + marker + text.slice(text.length - (keep - head));
}

/** One line-block per message Muse should see; assistant turns are Muse's own. */
export function formatMessage(message: MuseMessage, includeAssistant: boolean): string | undefined {
  if (message.role === "assistant") {
    if (!includeAssistant) return undefined;
    const lines: string[] = [];
    const text = textOf(message.content).trim();
    if (text) lines.push(text);
    if (typeof message.content !== "string") {
      for (const block of message.content) {
        if (block.type === "toolCall" && block.name) {
          lines.push(`@@RUN ${JSON.stringify({ name: block.name, arguments: block.arguments ?? {} })}`);
        }
      }
    }
    return lines.length > 0 ? `Assistant: ${lines.join("\n")}` : undefined;
  }
  if (message.role === "toolResult") {
    const text = textOf(message.content).trim();
    return `OUTPUT (${message.toolName ?? "tool"}, ${message.isError ? "error" : "ok"}):\n${text}`;
  }
  if (message.role === "system") return undefined;
  const text = textOf(message.content).trim();
  return text || undefined;
}

export function conversationKey(messages: MuseMessage[], salt = ""): string {
  const first = messages.find((message) => message.role === "user");
  const text = first ? textOf(first.content).slice(0, 2000) : "";
  return createHash("sha1").update(salt).update("\u0000").update(text).digest("hex");
}

export function newSessionId(): string {
  // The proxy accepts 1-64 ASCII letters, digits or hyphens.
  return `pi-${randomBytes(6).toString("hex")}`;
}

export interface Plan {
  key: string;
  sessionId: string;
  content: string;
  /** True when Muse has not seen this conversation (first turn, rewind, restart). */
  fresh: boolean;
  /** Message count to record once the request succeeds. */
  sentAfter: number;
}

interface State {
  sessionId: string;
  sent: number;
  turns: number;
  chars: number;
}

export class SessionTracker {
  private readonly states = new Map<string, State>();
  /** Every Muse chat this tracker started and has not retired yet. */
  private readonly owned = new Set<string>();
  /** Chats dropped along the way (rewind, wear, refusal), waiting for takeAbandoned(). */
  private abandoned: string[] = [];
  private readonly limits: PlanLimits;

  constructor(limits: PlanLimits = DEFAULT_LIMITS) {
    this.limits = limits;
  }

  plan(
    messages: MuseMessage[],
    systemPrompt: string | undefined,
    salt = "",
    limits: PlanLimits = this.limits,
    tools: ToolDef[] = [],
  ): Plan {
    const convo = messages.filter((message) => message.role !== "system");
    if (convo.length === 0) throw new Error("muse-proxy received an empty context");

    const key = conversationKey(convo, salt);
    const state = this.states.get(key);
    const worn = !!state && (
      state.turns >= (limits.rotateTurns ?? Infinity) || state.chars >= (limits.rotateChars ?? Infinity)
    );
    const fresh = !state || convo.length < state.sent || worn;
    if (fresh && state) this.abandon(state.sessionId);
    const sessionId = fresh ? newSessionId() : state!.sessionId;
    this.owned.add(sessionId);

    const content = fresh
      ? this.freshContent(convo, systemPrompt, limits, tools)
      : this.deltaContent(convo, state!.sent, limits, tools.length > 0);

    return { key, sessionId, content, fresh, sentAfter: convo.length };
  }

  commit(plan: Plan): void {
    const previous = this.states.get(plan.key);
    const sameChat = !plan.fresh && previous?.sessionId === plan.sessionId;
    this.states.set(plan.key, {
      sessionId: plan.sessionId,
      sent: plan.sentAfter,
      turns: (sameChat ? previous!.turns : 0) + 1,
      chars: (sameChat ? previous!.chars : 0) + plan.content.length,
    });
  }

  /** Forget a conversation so the next plan starts a brand-new Muse chat. */
  reset(key: string): void {
    const state = this.states.get(key);
    if (state) this.abandon(state.sessionId);
    this.states.delete(key);
  }

  /** Muse chats started here and still in use. */
  chats(): string[] {
    return [...this.owned];
  }

  /**
   * Retire every chat except `keep`: forget them and any conversation that was
   * using them, so the next plan opens a new chat. Returns the retired ids.
   * (Muse offers no call to delete a side chat, so this only ends our use of it.)
   */
  retire(keep: Iterable<string> = []): string[] {
    const spare = new Set(keep);
    const gone = [...this.owned].filter((id) => !spare.has(id));
    const goneSet = new Set(gone);
    for (const id of gone) this.owned.delete(id);
    for (const [key, state] of this.states) if (goneSet.has(state.sessionId)) this.states.delete(key);
    return gone;
  }

  /** Chats dropped by rewinds, wear and resets since the last call. */
  takeAbandoned(): string[] {
    const ids = this.abandoned;
    this.abandoned = [];
    return ids;
  }

  private abandon(sessionId: string): void {
    if (this.owned.delete(sessionId)) this.abandoned.push(sessionId);
  }

  private deltaContent(convo: MuseMessage[], sent: number, limits: PlanLimits, withTools: boolean): string {
    const fresh = convo.slice(sent).map((m) => formatMessage(m, false)).filter((x): x is string => !!x);
    // Nothing new apart from assistant turns: resend the latest user text rather than nothing.
    const parts = fresh.length > 0 ? fresh : [formatMessage(convo[convo.length - 1], true) ?? ""].filter(Boolean);
    const hasOutput = convo.slice(sent).some((m) => m.role === "toolResult");
    const tail = withTools && hasOutput ? [CONTINUE_NOTE] : [];
    // Every new block matters (parallel tool results), so share the budget
    // evenly instead of dropping older ones.
    const sep = "\n\n";
    const overhead = tail.join(sep).length + sep.length * (parts.length + tail.length);
    const share = Math.max(500, Math.floor((limits.maxChars - overhead) / Math.max(parts.length, 1)));
    const body = parts.map((part) => clip(part, share));
    return clip([...body, ...tail].join(sep), limits.maxChars);
  }

  private freshContent(
    convo: MuseMessage[],
    systemPrompt: string | undefined,
    limits: PlanLimits,
    tools: ToolDef[],
  ): string {
    const head: string[] = [tools.length > 0 ? toolPreamble(tools) : NO_TOOLS_NOTE];
    if (systemPrompt?.trim()) {
      const label = tools.length > 0
        ? "Background on how I like the work done (my coding assistant's guidelines):"
        : "Background:";
      head.push(`${label}\n${clip(systemPrompt.trim(), limits.systemChars)}`);
    }
    const blocks = convo.map((m) => formatMessage(m, true)).filter((x): x is string => !!x);
    const last = convo[convo.length - 1];
    const tail = tools.length > 0 && last.role === "toolResult" ? [CONTINUE_NOTE] : [];
    return this.fit(head, blocks, limits, tail);
  }

  /** Newest blocks win; the last block is always kept, clipped if it must be. */
  private fit(head: string[], blocks: string[], limits: PlanLimits, tail: string[] = []): string {
    const sep = "\n\n";
    const max = limits.maxChars;
    const headText = head.join(sep);
    const tailText = tail.join(sep);
    const last = blocks[blocks.length - 1] ?? "";
    const reserve = headText.length + (headText ? sep.length : 0) + tailText.length + (tailText ? sep.length : 0);
    const lastBudget = Math.max(max - reserve, Math.floor(max / 2));
    const keptLast = clip(last, lastBudget);

    const history: string[] = [];
    let used = reserve + keptLast.length;
    let dropped = false;
    for (let i = blocks.length - 2; i >= 0; i--) {
      const cost = blocks[i].length + sep.length;
      if (used + cost > max) { dropped = true; break; }
      history.unshift(blocks[i]);
      used += cost;
    }
    const marker = dropped ? ["[earlier messages omitted]"] : [];
    const parts = [headText, ...marker, ...history, keptLast, tailText].filter(Boolean);
    return clip(parts.join(sep), max);
  }
}
