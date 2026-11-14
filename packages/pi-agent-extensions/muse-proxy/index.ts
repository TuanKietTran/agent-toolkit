/**
 * muse-proxy Provider Extension for pi
 *
 * Registers `muse`, a provider that talks to a muse-proxy
 * (https://github.com/uezo/muse-proxy) over its OpenAI-compatible API.
 *
 * The proxy rejects client-supplied tool definitions and Muse refuses a
 * "harness" framing, so pi tools travel as plain conversation: the first
 * message says "I'm your hands on my laptop" and lists the tools, Muse asks for
 * one with an `@@RUN {"name":...,"arguments":{...}}` line, the provider
 * captures it as a real pi ToolCall, and the result goes back as "OUTPUT ...".
 * Muse keeps the history per `session_id` and the proxy forwards only the last
 * user message, so each turn sends just the new messages (see session.ts).
 *
 * Config (first match wins): env PI_MUSE_PROXY_URL / PI_MUSE_PROXY_KEY, then
 * ~/.pi/agent/muse-proxy.json {"baseUrl": "...", "apiKey": "..."}.
 */

import { randomUUID } from "node:crypto";
import { appendFileSync } from "node:fs";
import type {
  Api,
  AssistantMessage,
  AssistantMessageEventStream,
  Message,
  Model,
  SimpleStreamOptions,
  Tool,
  ToolCall,
  TranscriptContext,
} from "@earendil-works/pi-ai";
import * as piAi from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { DEFAULT_BASE_URL, errorMessageFromBody, loadConfig } from "./config.ts";
import { correctionMessage, parseRuns, type ToolDef } from "./protocol.ts";
import { DEFAULT_LIMITS, SessionTracker, type MuseMessage } from "./session.ts";
import { SseParser, isRefusal, isTransient, sleep } from "./stream.ts";

const { createAssistantMessageEventStream } = piAi;

const PROVIDER_ID = "muse";
const MODEL_ID = "muse";
// The proxy gives up after request_timeout_seconds (180 by default).
const REQUEST_TIMEOUT_MS = 200_000;

const piAiCompat = piAi as unknown as {
  getCurrentSystemPrompt?: (messages: Message[]) => string | undefined;
  getCurrentTools?: (messages: Message[]) => Tool[];
};

function getTools(context: { messages: Message[]; tools?: Tool[] }): Tool[] {
  if (typeof piAiCompat.getCurrentTools === "function") return piAiCompat.getCurrentTools(context.messages) ?? [];
  return context.tools ?? [];
}

const MAX_FORMAT_RETRIES = 2;

function getSystemPrompt(context: { messages: Message[]; systemPrompt?: string }): string | undefined {
  if (typeof piAiCompat.getCurrentSystemPrompt === "function") {
    return piAiCompat.getCurrentSystemPrompt(context.messages);
  }
  return context.systemPrompt;
}

const tracker = new SessionTracker();

/**
 * Set between pi's compaction start and end. The summary is written in plain
 * text with no tool protocol, and when it succeeds every related chat is
 * folded into one fresh chat that opens with that summary.
 */
let compacting: { chatsBefore: string[] } | undefined;

function emptyOutput(model: Model<Api>): AssistantMessage {
  return {
    role: "assistant",
    content: [],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "pending",
    timestamp: Date.now(),
  };
}

/**
 * Muse has no call (in the proxy or the gadget SDK) that deletes a side chat,
 * so retiring one only ends our use of it: it is forgotten, never resumed, and
 * a new conversation opens a new chat. This is the single place to hook real
 * deletion in if the proxy ever gains it.
 */
function reap(ids: string[], reason: string): void {
  if (ids.length > 0) debugLog({ retired: ids, reason });
}

interface MuseReply {
  /** Completed Muse messages, in order. */
  replies: string[];
}

let lastRequestAt = 0;

/** Opt-in: PI_MUSE_PROXY_DEBUG=<file> appends each request and reply as JSON lines. */
function debugLog(entry: Record<string, unknown>): void {
  const file = process.env.PI_MUSE_PROXY_DEBUG;
  if (!file) return;
  try { appendFileSync(file, JSON.stringify({ at: new Date().toISOString(), ...entry }) + "\n", { mode: 0o600 }); } catch { /* best effort */ }
}

/** Streams one request; `onProgress` receives Muse's status text as it arrives. */
async function askMuse(
  config: ReturnType<typeof loadConfig>,
  sessionId: string,
  content: string,
  signal: AbortSignal,
  onProgress: (text: string) => void,
): Promise<MuseReply> {
  const wait = lastRequestAt + config.minGapMs - Date.now();
  if (wait > 0) await sleep(wait, signal);
  lastRequestAt = Date.now();

  const response = await fetch(`${config.baseUrl}/chat/completions`, {
    method: "POST",
    headers: { authorization: `Bearer ${config.apiKey}`, "content-type": "application/json" },
    body: JSON.stringify({
      model: MODEL_ID,
      session_id: sessionId,
      stream: true,
      messages: [{ role: "user", content }],
    }),
    signal,
  });
  if (!response.ok || !response.body) {
    throw new Error(errorMessageFromBody(response.status, await response.text()));
  }

  const parser = new SseParser();
  const decoder = new TextDecoder();
  const replies: string[] = [];
  const reader = response.body.getReader();
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    for (const chunk of parser.push(decoder.decode(value, { stream: true }))) {
      if (chunk.error) throw new Error(`muse-proxy: ${chunk.error}`);
      if (chunk.kind === "progress") onProgress(chunk.text);
      else if (chunk.kind === "reply" || chunk.kind === "other") {
        // Reply chunks are whole messages; consecutive deltas of one message merge.
        if (chunk.text) replies.push(chunk.text);
      }
    }
  }
  const cleaned = replies.map((reply) => reply.trim()).filter(Boolean);
  debugLog({ sessionId, sent: content, replies: cleaned });
  return { replies: cleaned };
}

function streamMuse(
  model: Model<Api>,
  context: TranscriptContext,
  options?: SimpleStreamOptions,
): AssistantMessageEventStream {
  const stream = createAssistantMessageEventStream();

  (async () => {
    const output = emptyOutput(model);
    try {
      const config = loadConfig();
      // A compaction summary is plain text: never offer the @@RUN tool protocol during one.
      const tools = compacting ? [] : getTools(context);
      const toolDefs: ToolDef[] = tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
      }));
      const plan = tracker.plan(
        context.messages as unknown as MuseMessage[],
        getSystemPrompt(context),
        process.cwd(),
        { ...DEFAULT_LIMITS, maxChars: config.maxChars, rotateTurns: config.rotateTurns },
        toolDefs,
      );

      const signals = [AbortSignal.timeout(REQUEST_TIMEOUT_MS)];
      if (options?.signal) signals.push(options.signal);
      const signal = AbortSignal.any(signals);

      let currentPlan = plan;
      let content = plan.content;
      let text = "";
      let parsed = parseRuns("", toolDefs);
      let refusals = 0;
      let formatRetries = 0;

      // Muse's status text streams in as live thinking.
      let thinkingIndex = -1;
      let thinkingText = "";
      const seenProgress = new Set<string>();
      const onProgress = (raw: string) => {
        const line = raw.trim();
        if (!line || seenProgress.has(line)) return;
        seenProgress.add(line);
        if (thinkingIndex < 0) {
          thinkingIndex = output.content.length;
          output.content.push({ type: "thinking", thinking: "", thinkingSignature: "" } as any);
          stream.push({ type: "thinking_start", contentIndex: thinkingIndex, partial: output });
        }
        const delta = (thinkingText ? "\n" : "") + line;
        thinkingText += delta;
        (output.content[thinkingIndex] as any).thinking = thinkingText;
        stream.push({ type: "thinking_delta", contentIndex: thinkingIndex, delta, partial: output });
      };

      const rotate = () => {
        // Start a brand-new Muse chat carrying the recent context.
        tracker.reset(currentPlan.key);
        currentPlan = tracker.plan(
          context.messages as unknown as MuseMessage[],
          getSystemPrompt(context),
          process.cwd(),
          { ...DEFAULT_LIMITS, maxChars: config.maxChars, rotateTurns: config.rotateTurns },
          toolDefs,
        );
        content = currentPlan.content;
      };
      let transientRetries = 0;

      for (;;) {
        let replies: string[];
        try {
          ({ replies } = await askMuse(config, currentPlan.sessionId, content, signal, onProgress));
        } catch (error) {
          if (!isTransient(error) || signal.aborted || transientRetries >= 3) throw error;
          await sleep([5_000, 15_000, 30_000][transientRetries++], signal);
          continue;
        }
        const real = replies.filter((reply) => !isRefusal(reply));
        if (real.length === 0) {
          // Muse's canned "can't help" reply sticks to a chat (retrying in it never worked),
          // so move to a new chat at once; back off a little if the new one refuses too.
          refusals++;
          if (refusals > 3) throw new Error(`muse-proxy: Muse keeps refusing this conversation (${replies[0] ?? "no reply"})`);
          if (refusals > 1) await sleep(20_000, signal);
          rotate();
          continue;
        }
        text = real.join("\n\n");
        if (toolDefs.length === 0) break;
        parsed = parseRuns(text, toolDefs);
        // Ask Muse to fix a malformed request instead of silently dropping it.
        if (parsed.calls.length === 0 && parsed.errors.length > 0 && formatRetries < MAX_FORMAT_RETRIES) {
          formatRetries++;
          content = correctionMessage(parsed.errors);
          continue;
        }
        break;
      }
      tracker.commit(currentPlan);
      reap(tracker.takeAbandoned(), "rotated");

      const calls: ToolCall[] = parsed.calls.map((call) => ({
        type: "toolCall",
        id: `muse_${randomUUID()}`,
        name: call.name,
        arguments: call.arguments as ToolCall["arguments"],
      }));
      const prose = calls.length > 0 ? parsed.text : text;

      if (thinkingIndex >= 0) {
        stream.push({ type: "thinking_end", contentIndex: thinkingIndex, content: thinkingText, partial: output });
      }
      if (calls.length === 0 && !prose) {
        throw new Error("muse-proxy returned an empty reply (the request may have been superseded or cancelled)");
      }
      // Muse's non-command text renders as a normal text block, before any tool calls.
      if (prose) {
        const contentIndex = output.content.length;
        output.content.push({ type: "text", text: prose });
        stream.push({ type: "text_start", contentIndex, partial: output });
        stream.push({ type: "text_delta", contentIndex, delta: prose, partial: output });
        stream.push({ type: "text_end", contentIndex, content: prose, partial: output });
      }

      for (const call of calls) {
        const contentIndex = output.content.length;
        const block: ToolCall = { ...call, arguments: {} };
        output.content.push(block);
        stream.push({ type: "toolcall_start", contentIndex, partial: output });
        stream.push({ type: "toolcall_delta", contentIndex, delta: JSON.stringify(call.arguments), partial: output });
        block.arguments = call.arguments;
        stream.push({ type: "toolcall_end", contentIndex, toolCall: block, partial: output });
      }

      output.stopReason = calls.length > 0 ? "toolUse" : "stop";
      stream.push({ type: "done", reason: output.stopReason, message: output });
      stream.end();
    } catch (error) {
      output.stopReason = options?.signal?.aborted ? "aborted" : "error";
      output.errorMessage = error instanceof Error ? error.message : JSON.stringify(error);
      stream.push({ type: "error", reason: output.stopReason, error: output });
      stream.end();
    }
  })();

  return stream;
}

export default function (pi: ExtensionAPI) {
  // Any shutdown (quit, /new, resume, fork, reload) ends the conversation these chats served.
  pi.on("session_shutdown", (event) => {
    compacting = undefined;
    reap([...tracker.takeAbandoned(), ...tracker.retire()], event.reason);
  });

  // /compact: summarize as plain text, then gather the related chats into one.
  pi.on("session_before_compact", () => {
    compacting = { chatsBefore: tracker.chats() };
  });
  pi.on("session_compact", () => {
    compacting = undefined;
    reap([...tracker.takeAbandoned(), ...tracker.retire()], "compact");
  });
  pi.on("session_compact_failed", () => {
    // Keep the conversation's chats; drop only the one the summary request opened.
    const before = compacting?.chatsBefore ?? tracker.chats();
    compacting = undefined;
    reap(tracker.retire(before), "compact-failed");
  });

  pi.registerProvider(PROVIDER_ID, {
    baseUrl: DEFAULT_BASE_URL,
    apiKey: PROVIDER_ID,
    api: "muse-proxy-api",
    models: [
      {
        id: MODEL_ID,
        name: "Muse (muse-proxy)",
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        // Muse keeps the history server-side and only deltas are sent, so pi's own
        // transcript size is not bounded by Muse; a small window only triggers costly compaction.
        contextWindow: 400000,
        maxTokens: 8192,
      },
    ],
    streamSimple: streamMuse,
  });
}
