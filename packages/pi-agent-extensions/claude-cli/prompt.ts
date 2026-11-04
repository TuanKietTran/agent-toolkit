/**
 * Prompt assembly for the claude-cli provider, kept free of runtime imports so it
 * can be tested without Pi.
 *
 * Token budget rules this file implements (measurements in docs/TOKEN-DIET.md):
 * - Conversation history travels as one text block per message in the user turn, not
 *   inside the system prompt. The system prompt (Pi's prompt, bridge rules, response
 *   policy) is then identical on every turn and is read from the prompt cache; with the
 *   history inside it, every turn changed the system prompt and rewrote all of it
 *   (measured: about 3.4x more cache-write tokens). The history blocks themselves are
 *   still re-sent as new tokens each turn; see "What did not help" in docs/TOKEN-DIET.md.
 * - Tool schemas are sent once, as the MCP tool list. The prompt carries compact
 *   signatures only, as a fallback hint if the MCP list is missing.
 * - Tool call ids are replaced by short stable labels, and unusually large older
 *   tool results are cut with a visible marker.
 */
import type { Message, Tool } from "@earendil-works/pi-ai";

/** Older tool results above this many characters are shortened in the history. */
export const HISTORY_RESULT_LIMIT = 12_000;
const HISTORY_RESULT_HEAD = 8_000;
const HISTORY_RESULT_TAIL = 2_000;

/**
 * Replaces Claude Code's default system prompt. Native tools are disabled, so its
 * long tool-usage guidance is dead weight on every call. Pi's own prompt and the
 * bridge rules follow it.
 */
export const BASE_SYSTEM_PROMPT =
  "You are the model behind a coding-agent host called Pi. Follow the host instructions below. Claude Code's native tools are not available; act only through the host tools described there.";

/** The stub plus today's date, which Claude Code's own prompt would otherwise have supplied. */
export function baseSystemPrompt(now: Date = new Date()): string {
  const date = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
  return `${BASE_SYSTEM_PROMPT} Today's date: ${date}.`;
}

export const HISTORY_HEADER =
  "Conversation so far, oldest first. Respond to the last entry; earlier entries are context.";

export function contentText(content: Message["content"]): string {
  if (typeof content === "string") return content;
  return content
    .map((block: any) => (block.type === "text" ? block.text : "[image]"))
    .join("\n");
}

/** Cuts the middle out of a very large text, leaving a marker the model can act on. */
export function capText(text: string, limit = HISTORY_RESULT_LIMIT): string {
  if (text.length <= limit) return text;
  const omitted = text.length - HISTORY_RESULT_HEAD - HISTORY_RESULT_TAIL;
  return `${text.slice(0, HISTORY_RESULT_HEAD)}\n[... ${omitted} characters omitted from this older tool result; run the tool again if you need them ...]\n${text.slice(-HISTORY_RESULT_TAIL)}`;
}

/** Stable short labels (t1, t2, ...) for tool call ids, in order of appearance. */
export function labelToolCalls(messages: Message[]): Map<string, string> {
  const labels = new Map<string, string>();
  for (const message of messages) {
    if (message.role !== "assistant" || typeof message.content === "string") continue;
    for (const block of message.content) {
      if (block.type === "toolCall" && !labels.has(block.id)) labels.set(block.id, `t${labels.size + 1}`);
    }
  }
  return labels;
}

export function formatMessage(message: Message, labels: Map<string, string>, options: { cap?: boolean } = {}): string {
  if (message.role === "user") return `Human: ${contentText(message.content)}`;
  if (message.role === "system") return `System: ${contentText(message.content)}`;

  if (message.role === "toolResult") {
    const status = message.isError ? "error" : "success";
    const label = labels.get(message.toolCallId) ?? message.toolCallId.slice(-6);
    const body = contentText(message.content);
    return `Tool result (${status}) for ${message.toolName} [${label}]:\n${options.cap ? capText(body) : body}`;
  }

  const content = message.content;
  if (typeof content === "string") return `Assistant: ${content}`;
  const blocks = content.flatMap((block) => {
    if (block.type === "text") return block.text.trim() ? [block.text] : [];
    if (block.type === "toolCall") {
      return [`Tool call [${labels.get(block.id) ?? block.id.slice(-6)}]: ${block.name}(${JSON.stringify(block.arguments)})`];
    }
    return [];
  });
  return `Assistant: ${blocks.join("\n")}`;
}

/**
 * The newest entry, or, when the conversation ends in tool results, the whole run of
 * them: results of parallel calls arrive as separate messages and the model needs
 * every one of them in full, with their images.
 */
export function trailingBatch(messages: Message[]): Message[] {
  let start = messages.length - 1;
  if (start < 0) return [];
  if (messages[start].role === "toolResult") {
    while (start > 0 && messages[start - 1].role === "toolResult") start--;
  }
  return messages.slice(start);
}

/** One entry per non-empty message; older ones capped, the newest batch kept whole. */
export function buildTranscriptBlocks(messages: Message[]): string[] {
  const labels = labelToolCalls(messages);
  const batchStart = messages.length - trailingBatch(messages).length;
  const blocks = messages
    .map((message, index) => formatMessage(message, labels, { cap: index < batchStart }))
    .filter((part) => part.trim());
  return [HISTORY_HEADER, ...blocks];
}

export function toolSignature(tool: Tool): string {
  const schema = (tool.parameters ?? {}) as { properties?: Record<string, unknown>; required?: string[] };
  const required = new Set(schema.required ?? []);
  const params = Object.keys(schema.properties ?? {}).map((key) => (required.has(key) ? key : `${key}?`));
  return `${tool.name}(${params.join(", ")})`;
}

export function createToolBridgePrompt(tools: Tool[]): string {
  if (tools.length === 0) {
    return [
      "<pi_tool_bridge>",
      "No host tools are active. Return an empty tool_calls array and put the answer in text.",
      "</pi_tool_bridge>",
    ].join("\n");
  }
  return [
    "<pi_tool_bridge>",
    "Claude's native tools are disabled; that does not make the host tools unavailable. Use the mcp__pi-host__<name> tools for any filesystem, shell or edit work. Never say a tool is unavailable and never simulate a call in prose.",
    "A call only requests the action: the host runs it and the result arrives as the last entry of the conversation. Independent calls may be made together. When the last entry is a tool result, continue the task from it.",
    "When no tool is needed, return an empty tool_calls array and put the final answer in text. If the mcp__pi-host__ tools are missing, request the same tools through tool_calls with schema-valid arguments.",
    `Host tools: ${tools.map(toolSignature).join("; ")}`,
    "</pi_tool_bridge>",
  ].join("\n");
}

export function createOutputSchema(tools: Tool[], textSchema: Record<string, unknown>): Record<string, unknown> {
  const toolCallItems: Record<string, unknown> = {
    type: "object",
    properties: {
      name: tools.length > 0
        ? { type: "string", enum: tools.map((tool) => tool.name) }
        : { type: "string" },
      arguments: { type: "object" },
    },
    required: ["name", "arguments"],
    additionalProperties: false,
  };
  return {
    type: "object",
    properties: {
      text: textSchema,
      tool_calls: {
        type: "array",
        items: toolCallItems,
        ...(tools.length === 0 ? { maxItems: 0 } : {}),
      },
    },
    required: ["text", "tool_calls"],
    additionalProperties: false,
  };
}
