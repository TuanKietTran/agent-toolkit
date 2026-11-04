/**
 * Claude CLI Provider Extension for pi
 *
 * Wraps the local `claude` binary as a pi provider. Auth comes from
 * whatever `claude` is already logged in as — no separate API key needed.
 *
 * Pi owns tool execution: Claude's native tools are disabled, active Pi tool
 * schemas are supplied through a structured-output bridge, and requested calls
 * are emitted as real pi ToolCall blocks. This preserves Pi's tool allowlists,
 * lifecycle events, validation, and result handling.
 */

import { spawn } from "child_process";
import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { randomUUID } from "crypto";
import { homedir, tmpdir } from "os";
import { join } from "path";
import type {
  Api,
  AssistantMessage,
  AssistantMessageEventStream,
  Message,
  Model,
  SimpleStreamOptions,
  ThinkingContent,
  Tool,
  ToolCall,
  TranscriptContext,
} from "@earendil-works/pi-ai";
import * as piAi from "@earendil-works/pi-ai";

const { createAssistantMessageEventStream } = piAi;

// Newer pi-ai versions carry the prompt/tools on system messages and expose
// helpers to read them; older versions use context.systemPrompt/context.tools.
const piAiCompat = piAi as unknown as {
  getCurrentSystemPrompt?: (messages: Message[]) => string | undefined;
  getCurrentTools?: (messages: Message[]) => Tool[];
};

function getCurrentTools(context: { messages: Message[]; tools?: Tool[] }): Tool[] {
  if (typeof piAiCompat.getCurrentTools === "function") {
    return piAiCompat.getCurrentTools(context.messages) ?? [];
  }
  return context.tools ?? [];
}

function getCurrentSystemPrompt(context: {
  messages: Message[];
  systemPrompt?: string;
}): string | undefined {
  if (typeof piAiCompat.getCurrentSystemPrompt === "function") {
    return piAiCompat.getCurrentSystemPrompt(context.messages);
  }
  return context.systemPrompt;
}
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createClaudeStreamInput } from "./media.ts";
import { startMcpServer, type McpHandle } from "./mcp.ts";
import { estimateCostUsd } from "./cost-estimate.ts";
import { advisorArgs } from "./cli-args.ts";
import { EarlyStop } from "./early-stop.ts";
import { baseSystemPrompt, buildTranscriptBlocks, createOutputSchema, createToolBridgePrompt, trailingBatch } from "./prompt.ts";
import { RESPONSE_POLICY, TEXT_OUTPUT_SCHEMA } from "./response-policy.ts";
import { recordFromResult, writeUsageRecord } from "./usage-log.ts";

function resolveClaudeBin(): string {
  const candidates = [
    join(homedir(), ".local", "bin", "claude"),
    "/opt/homebrew/bin/claude",
    "/usr/local/bin/claude",
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return "claude"; // fall back to PATH lookup
}

// --- Constants: every local literal lives here. ---

const CLAUDE_BIN = resolveClaudeBin();
/** Acknowledgement the capture bridge returns if Claude is ever allowed to continue. */
const CAPTURE_ACK = "Request captured; the Pi host runs it after this turn.";
/** Safety net: how long a capture handler waits for the early stop before answering anyway. */
const HANDLER_HOLD_MS = 15_000;
const MEMORY_COMMAND = "memory";
const MEMORY_DESCRIPTION = "Add a memory line (/memory <text>) or edit CLAUDE.md memory files";

function parseStructuredOutput(value: unknown, tools: Tool[]): { text: string; toolCalls: ToolCall[] } {
  if (!value || typeof value !== "object") {
    throw new Error("claude CLI did not return structured output");
  }

  const candidate = value as { text?: unknown; tool_calls?: unknown };
  if (typeof candidate.text !== "string" || !Array.isArray(candidate.tool_calls)) {
    throw new Error("claude CLI returned invalid structured output");
  }

  const activeNames = new Set(tools.map((tool) => tool.name));
  const toolCalls = candidate.tool_calls.map((raw, index) => {
    if (!raw || typeof raw !== "object") {
      throw new Error(`claude CLI returned an invalid tool call at index ${index}`);
    }
    const call = raw as { name?: unknown; arguments?: unknown };
    if (typeof call.name !== "string" || !activeNames.has(call.name)) {
      throw new Error(`claude CLI requested inactive tool: ${String(call.name)}`);
    }
    if (!call.arguments || typeof call.arguments !== "object" || Array.isArray(call.arguments)) {
      throw new Error(`claude CLI returned invalid arguments for tool: ${call.name}`);
    }
    return {
      type: "toolCall" as const,
      id: `claude_cli_${randomUUID()}`,
      name: call.name,
      arguments: call.arguments as ToolCall["arguments"],
    };
  });

  return { text: candidate.text, toolCalls };
}

function streamClaudeCLI(
  model: Model<Api>,
  context: TranscriptContext,
  options?: SimpleStreamOptions,
): AssistantMessageEventStream {
  const stream = createAssistantMessageEventStream();

  (async () => {
    const output: AssistantMessage = {
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

    let mcp: McpHandle | undefined;
    try {
      // Providers receive a normalized transcript: prompt and active tool
      // declarations live on system messages rather than context fields.
      const tools = getCurrentTools(context);
      const systemPrompt = getCurrentSystemPrompt(context);
      const capturedCalls: ToolCall[] = [];
      // Pi only needs Claude's first message when it requests host tools. The calls are read
      // from that message's stream and the process is stopped at once (see early-stop.ts); the
      // capture handlers wait for that decision so Claude Code never starts the follow-up API
      // calls, and are released when the decision is "carry on" or the process ends.
      const earlyStop = new EarlyStop(new Set(tools.map((tool) => tool.name)));
      let streamCalls: ToolCall[] | undefined;
      let earlyStopped = false;
      let stopProcess: () => void = () => {};
      let releaseHandlers: () => void = () => {};
      const handlersReleased = new Promise<void>((resolve) => { releaseHandlers = resolve; });
      if (tools.length > 0) {
        mcp = await startMcpServer(
          "pi-host",
          tools.map((tool) => ({
            name: tool.name,
            description: tool.description,
            inputSchema: tool.parameters as Record<string, unknown>,
            handler: async (args) => {
              capturedCalls.push({
                type: "toolCall",
                id: `claude_cli_mcp_${randomUUID()}`,
                name: tool.name,
                arguments: args,
              });
              let timer: ReturnType<typeof setTimeout> | undefined;
              await Promise.race([
                handlersReleased,
                new Promise<void>((resolve) => { timer = setTimeout(resolve, HANDLER_HOLD_MS); timer.unref?.(); }),
              ]);
              clearTimeout(timer);
              return CAPTURE_ACK;
            },
          })),
        );
      }
      const messages = context.messages.filter((message) => message.role !== "system");
      const lastMsg = messages[messages.length - 1];
      if (!lastMsg) throw new Error("claude CLI received an empty context");

      const appendParts: string[] = [];
      if (systemPrompt) appendParts.push(systemPrompt);
      // Keep bridge instructions last so old conversation text and Claude Code's
      // disabled native-tool state cannot override the host-tool protocol.
      appendParts.push(createToolBridgePrompt(tools), RESPONSE_POLICY);
      const transcript = buildTranscriptBlocks(messages);

      // Windows rejects command lines over ~32K characters (ENAMETOOLONG from uv_spawn). The appended
      // system prompt carries Pi's full prompt, so it travels in a temporary file instead of an argument.
      const appendDir = mkdtempSync(join(tmpdir(), "pi-claude-cli-"));
      const appendFile = join(appendDir, "append-system-prompt.md");
      writeFileSync(appendFile, appendParts.join("\n\n"), "utf8");

      const args = [
        "-p",
        "--input-format", "stream-json",
        "--output-format", "stream-json",
        "--include-partial-messages",
        "--verbose",
        "--model", model.id,
        // Safe mode disables even the explicit capture MCP server. Loading no
        // user/project/local settings provides the same isolation while
        // keeping the per-turn --mcp-config available.
        "--setting-sources", "",
        "--disable-slash-commands",
        "--strict-mcp-config",
        "--mcp-config", mcp?.configPath ?? JSON.stringify({ mcpServers: {} }),
        "--tools", "",
        ...(mcp ? ["--allowedTools", ...mcp.allowedTools] : []),
        // Print mode otherwise defaults to forwarding permission requests to
        // its host. Pi owns tool execution, so no Claude permission UI or
        // allow/deny request should escape this provider boundary.
        "--permission-mode", "dontAsk",
        "--permission-prompts", "none",
        "--no-session-persistence",
        "--json-schema", JSON.stringify(createOutputSchema(tools, TEXT_OUTPUT_SCHEMA)),
        "--system-prompt", baseSystemPrompt(),
        "--append-system-prompt-file", appendFile,
      ];
      args.push(...advisorArgs());
      if (options?.reasoning) {
        args.push("--effort", options.reasoning === "minimal" ? "low" : options.reasoning);
      }

      const startedAt = Date.now();
      const proc = spawn(CLAUDE_BIN, args, { env: { ...process.env } });
      stopProcess = () => proc.kill("SIGTERM");
      const removeAppendFile = () => {
        try { rmSync(appendDir, { recursive: true, force: true }); } catch { /* best effort */ }
      };
      proc.on("close", removeAppendFile);
      proc.on("error", removeAppendFile);
      proc.stdin.end(createClaudeStreamInput(trailingBatch(messages), transcript));

      stream.push({ type: "start", partial: output });

      const usageBase = {
        ts: new Date().toISOString(),
        model: model.id,
        appendChars: appendParts.join("\n\n").length,
        schemaChars: JSON.stringify(createOutputSchema(tools, TEXT_OUTPUT_SCHEMA)).length,
        toolDefChars: JSON.stringify(tools.map((t) => ({ name: t.name, description: t.description, parameters: t.parameters }))).length,
        tools: tools.length,
        historyMessages: messages.length - 1,
      };

      type TrackedThinking = ThinkingContent & { _idx: number };
      const blocks: TrackedThinking[] = [];
      let structuredOutput: unknown;
      let resultError: string | undefined;
      let buf = "";
      let stderrBuf = "";

      proc.stdout.on("data", (chunk: Buffer) => {
        buf += chunk.toString();
        const lines = buf.split("\n");
        buf = lines.pop() ?? "";

        for (const line of lines) {
          if (!line.trim()) continue;
          let ev: any;
          try { ev = JSON.parse(line); } catch { continue; }

          if (ev.type === "stream_event") {
            const e = ev.event;
            const decision = earlyStop.observe(e);
            if (decision?.stop) {
              streamCalls = decision.calls.map((call) => ({
                type: "toolCall" as const,
                id: `claude_cli_${randomUUID()}`,
                name: call.name,
                arguments: call.arguments as ToolCall["arguments"],
              }));
              earlyStopped = true;
              releaseHandlers();
              stopProcess();
            } else if (decision) {
              releaseHandlers();
            }

            if (e.type === "message_start" && e.message?.usage) {
              const u = e.message.usage;
              output.usage.input = u.input_tokens ?? 0;
              output.usage.cacheRead = u.cache_read_input_tokens ?? 0;
              output.usage.cacheWrite = u.cache_creation_input_tokens ?? 0;

            } else if (e.type === "content_block_start" && e.content_block.type === "thinking") {
              const block = {
                type: "thinking" as const,
                thinking: "",
                thinkingSignature: "",
                _idx: e.index,
              } as TrackedThinking;
              output.content.push(block as any);
              blocks.push(block);
              stream.push({ type: "thinking_start", contentIndex: output.content.length - 1, partial: output });

            } else if (e.type === "content_block_delta") {
              const block = blocks.find((candidate) => candidate._idx === e.index);
              if (!block) continue;
              const contentIndex = output.content.indexOf(block as any);

              if (e.delta.type === "thinking_delta") {
                block.thinking += e.delta.thinking;
                stream.push({ type: "thinking_delta", contentIndex, delta: e.delta.thinking, partial: output });
              } else if (e.delta.type === "signature_delta") {
                block.thinkingSignature = (block.thinkingSignature ?? "") + e.delta.signature;
              }

            } else if (e.type === "content_block_stop") {
              const block = blocks.find((candidate) => candidate._idx === e.index);
              if (!block) continue;
              const contentIndex = output.content.indexOf(block as any);
              delete (block as any)._idx;
              stream.push({ type: "thinking_end", contentIndex, content: block.thinking, partial: output });

            } else if (e.type === "message_delta" && e.usage) {
              output.usage.output = e.usage.output_tokens ?? 0;
              output.usage.totalTokens =
                output.usage.input + output.usage.output +
                output.usage.cacheRead + output.usage.cacheWrite;
            }

          } else if (ev.type === "result") {
            structuredOutput = ev.structured_output;
            if (ev.total_cost_usd != null) output.usage.cost.total = ev.total_cost_usd;
            if (ev.usage) {
              output.usage.input = ev.usage.input_tokens ?? output.usage.input;
              output.usage.output = ev.usage.output_tokens ?? output.usage.output;
              output.usage.cacheRead = ev.usage.cache_read_input_tokens ?? output.usage.cacheRead;
              output.usage.cacheWrite = ev.usage.cache_creation_input_tokens ?? output.usage.cacheWrite;
              output.usage.reasoning = ev.usage.output_tokens_details?.thinking_tokens;
              output.usage.totalTokens =
                output.usage.input + output.usage.output +
                output.usage.cacheRead + output.usage.cacheWrite;
            }
            if (ev.is_error || ev.subtype === "error") {
              resultError = ev.error ?? ev.result ?? "claude CLI error";
            }
            writeUsageRecord(recordFromResult(ev, usageBase));

          }
        }
      });

      proc.stderr.on("data", (c: Buffer) => { stderrBuf += c.toString(); });

      await new Promise<void>((resolve, reject) => {
        proc.on("close", (code) => {
          releaseHandlers();
          if (code === 0 || earlyStopped) resolve();
          else reject(new Error(resultError ?? `claude exited ${code}: ${stderrBuf.slice(0, 500)}`));
        });
        proc.on("error", reject);
        options?.signal?.addEventListener("abort", () => proc.kill("SIGTERM"), { once: true });
      });

      if (earlyStopped) {
        const estimate = estimateCostUsd(model.id, output.usage);
        if (estimate !== undefined) output.usage.cost.total = estimate;
        writeUsageRecord({
          ...usageBase,
          apiTurns: 1,
          durationMs: Date.now() - startedAt,
          input: output.usage.input,
          cacheWrite: output.usage.cacheWrite,
          cacheRead: output.usage.cacheRead,
          output: output.usage.output,
          costUsd: estimate,
        });
      }
      if (resultError) throw new Error(resultError);
      // Claude Code may call the loopback MCP tools before it produces its
      // structured final output. Those calls are requests only: emit them as
      // Pi ToolCall blocks and discard Claude's acknowledgement text. Keep the
      // structured-output path as a fallback for models that follow it directly.
      const result = streamCalls
        ? { text: "", toolCalls: streamCalls }
        : capturedCalls.length > 0
        ? { text: "", toolCalls: capturedCalls }
        : parseStructuredOutput(structuredOutput, tools);

      if (result.text) {
        const contentIndex = output.content.length;
        output.content.push({ type: "text", text: result.text });
        stream.push({ type: "text_start", contentIndex, partial: output });
        stream.push({ type: "text_delta", contentIndex, delta: result.text, partial: output });
        stream.push({ type: "text_end", contentIndex, content: result.text, partial: output });
      }

      for (const call of result.toolCalls) {
        const contentIndex = output.content.length;
        const block: ToolCall = { ...call, arguments: {} };
        output.content.push(block);
        stream.push({ type: "toolcall_start", contentIndex, partial: output });
        const delta = JSON.stringify(call.arguments);
        stream.push({ type: "toolcall_delta", contentIndex, delta, partial: output });
        block.arguments = call.arguments;
        stream.push({ type: "toolcall_end", contentIndex, toolCall: block, partial: output });
      }

      output.stopReason = result.toolCalls.length > 0 ? "toolUse" : "stop";
      stream.push({ type: "done", reason: output.stopReason, message: output });
      stream.end();
    } catch (error) {
      for (const b of output.content) delete (b as any)._idx;
      output.stopReason = options?.signal?.aborted ? "aborted" : "error";
      output.errorMessage = error instanceof Error ? error.message : JSON.stringify(error);
      stream.push({ type: "error", reason: output.stopReason, error: output });
      stream.end();
    } finally {
      mcp?.close();
    }
  })();

  return stream;
}

// Companion command for Claude's on-disk memory. Pi already provides native
// /compact and /resume commands, so this extension intentionally does not
// register conflicting aliases for them.
function registerCliCommands(pi: ExtensionAPI): void {
  // /memory — view/edit Claude's memory (CLAUDE.md). With text, quick-adds a
  // bullet to the project file (like Claude Code's `#` shortcut); with no args,
  // opens a chosen memory file in the editor and saves edits back.
  pi.registerCommand(MEMORY_COMMAND, {
    description: MEMORY_DESCRIPTION,
    handler: async (args, ctx) => {
      const projectMem = join(ctx.cwd, "CLAUDE.md");
      const userMem = join(homedir(), ".claude", "CLAUDE.md");

      const text = args.trim();
      if (text) {
        const bullet = text.startsWith("-") ? text : `- ${text}`;
        const header = existsSync(projectMem) ? "" : "# Project memory\n\n";
        appendFileSync(projectMem, `${header}${bullet}\n`);
        ctx.ui.notify(`Added to ${projectMem}`, "info");
        return;
      }

      if (!ctx.hasUI) {
        ctx.ui.notify("/memory needs an interactive session (or use /memory <text>)", "warning");
        return;
      }
      const target = await ctx.ui.select("Edit which memory file?", [
        `Project — ${projectMem}`,
        `User — ${userMem}`,
      ]);
      if (!target) return;
      const path = target.startsWith("Project") ? projectMem : userMem;
      const existing = existsSync(path) ? readFileSync(path, "utf8") : "";
      const edited = await ctx.ui.editor(`Edit ${path}`, existing);
      if (edited == null || edited === existing) return;
      writeFileSync(path, edited);
      ctx.ui.notify(`Saved ${path}`, "info");
    },
  });
}

export default function (pi: ExtensionAPI) {
  pi.registerProvider("claude-cli", {
    baseUrl: "https://api.anthropic.com",
    apiKey: "claude-cli",
    api: "claude-cli-api",

    models: [
      {
        id: "claude-fable-5",
        name: "Claude Fable 5 (CLI)",
        reasoning: true,
        input: ["text", "image"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 200000,
        maxTokens: 64000,
      },
      {
        id: "claude-opus-5-5",
        name: "Claude Opus 5.5 (CLI)",
        reasoning: true,
        input: ["text", "image"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 1000000,
        maxTokens: 128000,
      },
      {
        id: "claude-opus-5",
        name: "Claude Opus 5 (CLI)",
        reasoning: true,
        input: ["text", "image"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 1000000,
        maxTokens: 128000,
      },
      {
        id: "claude-opus-4-8",
        name: "Claude Opus 4.8 (CLI)",
        reasoning: true,
        input: ["text", "image"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 200000,
        maxTokens: 32000,
      },
      {
        id: "claude-sonnet-5-5",
        name: "Claude Sonnet 5.5 (CLI)",
        reasoning: true,
        input: ["text", "image"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 200000,
        maxTokens: 64000,
      },
      {
        id: "claude-sonnet-5",
        name: "Claude Sonnet 5 (CLI)",
        reasoning: true,
        input: ["text", "image"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 200000,
        maxTokens: 64000,
      },
      {
        id: "claude-sonnet-4-6",
        name: "Claude Sonnet 4.6 (CLI)",
        reasoning: true,
        input: ["text", "image"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 200000,
        maxTokens: 64000,
      },
      {
        id: "claude-haiku-5-5",
        name: "Claude Haiku 5.5 (CLI)",
        reasoning: true,
        input: ["text", "image"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 200000,
        maxTokens: 64000,
      },
      {
        id: "claude-haiku-4-5-20251001",
        name: "Claude Haiku 4.5 (CLI)",
        reasoning: false,
        input: ["text", "image"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 200000,
        maxTokens: 64000,
      },
    ],

    streamSimple: streamClaudeCLI,
  });

  registerCliCommands(pi);
}
