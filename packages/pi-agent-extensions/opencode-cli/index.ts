/**
 * OpenCode CLI Provider Extension for pi
 *
 * Wraps the local `opencode` binary as a pi provider, the same way
 * claude-cli wraps `claude`. Auth and model access come from
 * whatever `opencode` already has (`opencode auth login`, or the free OpenCode
 * Zen models); no separate API key is needed.
 *
 * Pi owns tool execution: OpenCode's native tools are denied for the run and
 * Pi's active tools are exposed through a capture-only loopback MCP bridge.
 * Requested calls are emitted as real pi ToolCall blocks.
 */

import { execFileSync, spawn } from "child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "fs";
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
  Tool,
  ToolCall,
  TranscriptContext,
} from "@earendil-works/pi-ai";
import * as piAi from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { startMcpServer, type McpHandle } from "./mcp.ts";
import { RESPONSE_POLICY } from "./response-policy.ts";
import {
  applyEvent,
  buildPermissions,
  dedupeCalls,
  extractTextToolCalls,
  newUsage,
  parseEventLine,
  type ReadPermission,
} from "./events.ts";

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

// --- Constants: every local literal lives here. ---

const PROVIDER_ID = "opencode-cli";
const MCP_SERVER = "pi-host";
const AGENT_NAME = "pi-bridge";
const MODEL_LIST_TIMEOUT_MS = 8000;
const FALLBACK_MODELS = [
  "opencode/big-pickle",
  "opencode/deepseek-v4.1-flash-free",
  "opencode/glm-5.3-flash-free",
  "opencode/flint-40b-free",
];
const AGENT_PROMPT = [
  "You are the model backend for Pi, a coding-agent host.",
  "The user message contains Pi's system prompt, the conversation so far, tool-bridge instructions and the current message. Follow them.",
  `Never use OpenCode's own tools; the only permitted use of \`execute\` is calling tools["${MCP_SERVER}"].<name>(...) as the bridge instructions describe.`,
].join("\n");

function resolveOpencodeBin(): string {
  if (process.env.OPENCODE_BIN) return process.env.OPENCODE_BIN;
  const candidates = [
    join(homedir(), ".opencode", "bin", "opencode"),
    "/opt/homebrew/bin/opencode",
    "/usr/local/bin/opencode",
    join(homedir(), ".local", "bin", "opencode"),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return "opencode"; // fall back to PATH lookup
}

const OPENCODE_BIN = resolveOpencodeBin();

/** Model ids as `provider/model`. PI_OPENCODE_MODELS overrides discovery. */
function discoverModelIds(): string[] {
  const override = process.env.PI_OPENCODE_MODELS;
  if (override) return override.split(",").map((id) => id.trim()).filter(Boolean);
  try {
    const out = execFileSync(OPENCODE_BIN, ["models"], {
      encoding: "utf8",
      timeout: MODEL_LIST_TIMEOUT_MS,
      stdio: ["ignore", "pipe", "ignore"],
    });
    const ids = out.split("\n").map((line) => line.trim()).filter((line) => /^[\w.-]+\/\S+$/.test(line));
    if (ids.length > 0) return ids;
  } catch {
    // opencode missing or slow: fall through to the static list.
  }
  return FALLBACK_MODELS;
}

function modelEntry(id: string) {
  const vision = /(^|[-/])(vl|vision)([-/]|$)|claude|gpt|gemini/i.test(id);
  return {
    id,
    name: `${id} (OpenCode)`,
    reasoning: true,
    input: (vision ? ["text", "image"] : ["text"]) as ("text" | "image")[],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128000,
    maxTokens: 32000,
  };
}

function contentText(content: Message["content"]): string {
  if (typeof content === "string") return content;
  return content
    .map((block: any) => block.type === "text" ? block.text : "[image]")
    .join("\n");
}

function formatMessage(message: Message): string {
  if (message.role === "user") return `Human: ${contentText(message.content)}`;

  if (message.role === "system") return `System: ${contentText(message.content)}`;

  if (message.role === "toolResult") {
    const status = message.isError ? "error" : "success";
    return `Tool result (${status}) for ${message.toolName} [${message.toolCallId}]:\n${contentText(message.content)}`;
  }

  const content = message.content;
  if (typeof content === "string") return `Assistant: ${content}`;

  const blocks = content.flatMap((block) => {
    if (block.type === "text") return block.text.trim() ? [block.text] : [];
    if (block.type === "toolCall") {
      return [`Tool call [${block.id}]: ${block.name}(${JSON.stringify(block.arguments)})`];
    }
    return [];
  });
  return `Assistant: ${blocks.join("\n")}`;
}

function buildHistory(messages: Message[]): string {
  return messages.map(formatMessage).filter((part) => part.trim()).join("\n\n");
}

function createToolBridgePrompt(tools: Tool[]): string {
  if (tools.length === 0) {
    return [
      "<pi_tool_bridge>",
      "No host tools are active. Do not call any tool; put the answer in plain text.",
      "</pi_tool_bridge>",
    ].join("\n");
  }

  const definitions = tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
  }));

  return [
    "<pi_tool_bridge>",
    "OpenCode's own tools are disabled. The Pi host tools listed below ARE available and are the only tools you may use.",
    `Call them through the \`execute\` tool: return await tools["${MCP_SERVER}"].<name>({ ...arguments }). Independent calls may go in one execute using Promise.all.`,
    "Each call is only CAPTURED, not run. Its reply says so. Do not retry, do not call it again, and do not report a result: end your turn immediately after the capture.",
    "Pi runs the captured calls and sends the results in the next message; then continue the task, requesting more host tools the same way, or give the final answer as plain text.",
    `If tools["${MCP_SERVER}"] is missing, instead end your reply with <pi_tool_calls>[{"name":"<tool>","arguments":{...}}]</pi_tool_calls> and stop.`,
    "Use exact tool names and schema-valid arguments. Never simulate a tool call in prose and never claim a listed tool is unavailable.",
    "Active Pi host tool definitions:",
    JSON.stringify(definitions),
    "</pi_tool_bridge>",
  ].join("\n");
}

function readPermission(): ReadPermission {
  return process.env.PI_OPENCODE_READ === "deny" ? "deny" : "ask";
}

function createRunConfig(mcp: McpHandle | undefined): Record<string, unknown> {
  return {
    autoupdate: false,
    share: "disabled",
    ...(mcp
      ? {
          mcp: {
            [MCP_SERVER]: {
              type: "remote",
              url: mcp.url,
              headers: { Authorization: `Bearer ${mcp.token}` },
              enabled: true,
            },
          },
        }
      : {}),
    agent: {
      [AGENT_NAME]: {
        mode: "primary",
        prompt: AGENT_PROMPT,
        permission: buildPermissions(readPermission()),
      },
    },
  };
}

const IMAGE_EXT: Record<string, string> = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/gif": ".gif",
  "image/webp": ".webp",
};

/**
 * Write the message's image blocks to files for `opencode run --file`. The
 * temp directory is created only when there is an image to write, so a
 * text-only turn leaves nothing behind even if pi is killed mid-turn.
 */
function writeImages(message: Message): { files: string[]; dir?: string } {
  if (!Array.isArray(message.content)) return { files: [] };
  const files: string[] = [];
  let dir: string | undefined;
  for (const block of message.content as any[]) {
    if (block.type !== "image") continue;
    dir ??= mkdtempSync(join(tmpdir(), "pi-opencode-cli-"));
    const path = join(dir, `image-${files.length}${IMAGE_EXT[block.mimeType] ?? ".png"}`);
    writeFileSync(path, Buffer.from(block.data, "base64"));
    files.push(path);
  }
  return { files, dir };
}

function streamOpencodeCLI(
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
    let workDir: string | undefined;
    let sessionId: string | undefined;
    try {
      const tools = getCurrentTools(context);
      const systemPrompt = getCurrentSystemPrompt(context);
      const capturedCalls: ToolCall[] = [];
      if (tools.length > 0) {
        mcp = await startMcpServer(
          MCP_SERVER,
          tools.map((tool) => ({
            name: tool.name,
            description: `${tool.description}\nThis is a Pi host tool. The bridge captures the request; Pi executes it after OpenCode returns.`,
            inputSchema: tool.parameters as Record<string, unknown>,
            handler: (args) => {
              capturedCalls.push({
                type: "toolCall",
                id: `opencode_cli_mcp_${randomUUID()}`,
                name: tool.name,
                arguments: args,
              });
              return "Captured. Pi will run this call and send the result in the next message. Do not call it again and do not retry; end your turn now with no further output.";
            },
          })),
        );
      }

      const messages = context.messages.filter((message) => message.role !== "system");
      const lastMsg = messages[messages.length - 1];
      if (!lastMsg) throw new Error("opencode CLI received an empty context");

      const images = writeImages(lastMsg);
      workDir = images.dir;
      const imageFiles = images.files;

      // The whole prompt travels on stdin: it grows every turn and would
      // otherwise compete with the environment for the OS argument budget.
      const history = messages.slice(0, -1);
      const promptParts: string[] = [];
      if (systemPrompt) promptParts.push(`<pi_system>\n${systemPrompt}\n</pi_system>`);
      if (history.length > 0) {
        promptParts.push(`<conversation_history>\n${buildHistory(history)}\n</conversation_history>`);
      }
      // Bridge instructions sit right before the live message so old
      // conversation text cannot override the host-tool protocol.
      promptParts.push(createToolBridgePrompt(tools), RESPONSE_POLICY);
      promptParts.push(
        lastMsg.role === "toolResult"
          ? `${formatMessage(lastMsg)}\n\nContinue the task using this result. Request any next Pi host call only through the bridge.`
          : formatMessage(lastMsg),
      );

      const args = [
        "run",
        // A private server so the per-run config below applies; the shared
        // background service would ignore it.
        "--standalone",
        "--format", "json",
        "--agent", AGENT_NAME,
        "--model", model.id,
      ];
      if (options?.reasoning) args.push("--thinking");
      for (const file of imageFiles) args.push("--file", file);

      const proc = spawn(OPENCODE_BIN, args, {
        cwd: process.cwd(),
        env: { ...process.env, OPENCODE_CONFIG_CONTENT: JSON.stringify(createRunConfig(mcp)) },
      });
      // `opencode run` reads the message from stdin when it is piped, and
      // blocks until the pipe closes.
      proc.stdin.on("error", () => { /* process already gone */ });
      proc.stdin.end(promptParts.join("\n\n"));

      stream.push({ type: "start", partial: output });

      const usage = newUsage();
      const thinking: string[] = [];
      const texts: string[] = [];
      let resultError: string | undefined;
      let stoppedAfterCapture = false;
      let buf = "";
      let stderrBuf = "";

      const handleLine = (line: string) => {
        const ev = parseEventLine(line);
        if (!ev) return;
        if (typeof ev.sessionID === "string") sessionId ??= ev.sessionID;
        const action = applyEvent(ev, usage);
        if (action.kind === "text") texts.push(action.text);
        else if (action.kind === "thinking") thinking.push(action.text);
        else if (action.kind === "error") resultError ??= action.message;
        else if (action.kind === "stepFinish" && capturedCalls.length > 0 && !stoppedAfterCapture) {
          // The step that issued the calls is complete. Anything further would
          // be the model reacting to a placeholder result, so stop here.
          stoppedAfterCapture = true;
          proc.kill("SIGTERM");
        }
      };

      proc.stdout.on("data", (chunk: Buffer) => {
        buf += chunk.toString();
        const lines = buf.split("\n");
        buf = lines.pop() ?? "";
        lines.forEach(handleLine);
      });
      proc.stderr.on("data", (c: Buffer) => { stderrBuf += c.toString(); });

      await new Promise<void>((resolve, reject) => {
        proc.on("close", (code) => {
          if (buf.trim()) handleLine(buf);
          if (stoppedAfterCapture || (code === 0 && !resultError)) resolve();
          else reject(new Error(resultError ?? `opencode exited ${code}: ${stderrBuf.slice(0, 500)}`));
        });
        proc.on("error", reject);
        options?.signal?.addEventListener("abort", () => proc.kill("SIGTERM"));
      });

      if (resultError && !stoppedAfterCapture) throw new Error(resultError);

      let text = texts.join("\n\n").trim();
      let toolCalls: ToolCall[] = dedupeCalls(capturedCalls);
      if (toolCalls.length === 0 && tools.length > 0) {
        const parsed = extractTextToolCalls(text, new Set(tools.map((tool) => tool.name)));
        text = parsed.text;
        toolCalls = dedupeCalls(
          parsed.calls.map((call) => ({
            type: "toolCall" as const,
            id: `opencode_cli_${randomUUID()}`,
            name: call.name,
            arguments: call.arguments as ToolCall["arguments"],
          })),
        );
      }
      // Text written alongside captured calls is the model narrating a call
      // that Pi is about to make; drop it as the claude-cli provider does.
      if (toolCalls.length > 0) text = "";

      output.usage.input = usage.input;
      output.usage.output = usage.output;
      output.usage.cacheRead = usage.cacheRead;
      output.usage.cacheWrite = usage.cacheWrite;
      output.usage.reasoning = usage.reasoning;
      output.usage.cost.total = usage.cost;
      output.usage.totalTokens = usage.input + usage.output + usage.cacheRead + usage.cacheWrite;

      const thinkingText = thinking.join("\n\n");
      if (thinkingText) {
        const contentIndex = output.content.length;
        output.content.push({ type: "thinking", thinking: thinkingText, thinkingSignature: "" } as any);
        stream.push({ type: "thinking_start", contentIndex, partial: output });
        stream.push({ type: "thinking_delta", contentIndex, delta: thinkingText, partial: output });
        stream.push({ type: "thinking_end", contentIndex, content: thinkingText, partial: output });
      }

      if (text) {
        const contentIndex = output.content.length;
        output.content.push({ type: "text", text });
        stream.push({ type: "text_start", contentIndex, partial: output });
        stream.push({ type: "text_delta", contentIndex, delta: text, partial: output });
        stream.push({ type: "text_end", contentIndex, content: text, partial: output });
      }

      for (const call of toolCalls) {
        const contentIndex = output.content.length;
        const block: ToolCall = { ...call, arguments: {} };
        output.content.push(block);
        stream.push({ type: "toolcall_start", contentIndex, partial: output });
        stream.push({ type: "toolcall_delta", contentIndex, delta: JSON.stringify(call.arguments), partial: output });
        block.arguments = call.arguments;
        stream.push({ type: "toolcall_end", contentIndex, toolCall: block, partial: output });
      }

      output.stopReason = toolCalls.length > 0 ? "toolUse" : "stop";
      stream.push({ type: "done", reason: output.stopReason, message: output });
      stream.end();
    } catch (error) {
      output.stopReason = options?.signal?.aborted ? "aborted" : "error";
      output.errorMessage = error instanceof Error ? error.message : JSON.stringify(error);
      stream.push({ type: "error", reason: output.stopReason, error: output });
      stream.end();
    } finally {
      mcp?.close();
      if (workDir) {
        try { rmSync(workDir, { recursive: true, force: true }); } catch { /* best effort */ }
      }
      // Each run leaves a session in OpenCode's database; Pi owns the history.
      if (sessionId) {
        try {
          spawn(OPENCODE_BIN, ["session", "delete", "--standalone", sessionId], {
            cwd: process.cwd(),
            stdio: "ignore",
            detached: true,
          }).unref();
        } catch { /* best effort */ }
      }
    }
  })();

  return stream;
}

export default function (pi: ExtensionAPI) {
  pi.registerProvider(PROVIDER_ID, {
    baseUrl: "https://opencode.ai",
    apiKey: PROVIDER_ID,
    api: "opencode-cli-api",
    models: discoverModelIds().map(modelEntry),
    streamSimple: streamOpencodeCLI,
  });
}
