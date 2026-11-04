// file-tool-discipline — keep GPT file mutations on Pi's auditable write/edit tools.
//
// GPT coding models are strongly trained to use shell heredocs and small Python/
// Node scripts. Pi exposes `write`, but its built-in prompt only says to use it
// for new files or complete rewrites, so shell authoring remains common. This
// extension adds explicit guidance and blocks only obvious direct content writes;
// normal shell commands, generated build artifacts, logs, and temporary files
// remain available.

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { prompt } from "../md.ts";

import { PI_EVENT } from "../events.ts";

// --- Constants: every local literal lives here. ---

const RULES_FILE = "rules.md";
const FILE_POLICY_HEADING = "file-policy";
const TOOL_BASH = "bash";
const TOOL_POWERSHELL = "powershell";
const TOOL_WRITE = "write";
const TOOL_EDIT = "edit";
const PROVIDER_OPENAI = "openai";
const MODEL_GPT_PREFIX = "gpt-";
const DEV_NULL = "/dev/null";
const TMP_PREFIXES = ["/tmp/", "${TMPDIR}", "$TMPDIR", "${TMP}", "$TMP"];
const BLOCK_REASON =
  "Use Pi's write tool for new/full files or edit for targeted changes; direct shell-based file authoring is disabled for GPT models.";

const FILE_POLICY = prompt(RULES_FILE, FILE_POLICY_HEADING);

function isGpt(ctx: ExtensionContext): boolean {
  const provider = ctx.model?.provider.toLowerCase() ?? "";
  const model = ctx.model?.id.toLowerCase() ?? "";
  return provider.includes(PROVIDER_OPENAI) || model.startsWith(MODEL_GPT_PREFIX);
}

function hasFileTools(pi: ExtensionAPI): boolean {
  const active = new Set(pi.getActiveTools());
  return active.has(TOOL_WRITE) && active.has(TOOL_EDIT);
}

function isTemporaryTarget(target: string): boolean {
  const value = target.replace(/^['"]|['"]$/g, "");
  return value === DEV_NULL || TMP_PREFIXES.some((prefix) => value.startsWith(prefix));
}

function hasProjectRedirection(command: string): boolean {
  const redirects = command.matchAll(/(?:^|[\s;&|])(?:\d*)(?:>>|>)[ \t]*(?!&)("[^"]+"|'[^']+'|[^\s;&|]+)/gm);
  for (const match of redirects) {
    if (!isTemporaryTarget(match[1] ?? "")) return true;
  }
  return false;
}

function hasProjectTeeTarget(command: string): boolean {
  const invocations = command.matchAll(/(?:^|[;&|]\s*)tee\b(?:\s+-[^\s]+)*\s+("[^"]+"|'[^']+'|[^\s;&|]+)/gm);
  for (const match of invocations) {
    if (!isTemporaryTarget(match[1] ?? "")) return true;
  }
  return false;
}

export function directlyAuthorsFile(toolName: string, command: string): boolean {
  if (toolName === TOOL_POWERSHELL) {
    return /\b(?:Set-Content|Add-Content|Out-File)\b|\[IO\.File\]::Write(?:AllText|AllLines|AllBytes)/i.test(command);
  }
  if (toolName !== TOOL_BASH) return false;

  const shellAuthor = (
    /(?:^|[;&|]\s*)(?:cat|echo|printf)\b/m.test(command) && hasProjectRedirection(command)
  ) || hasProjectTeeTarget(command);
  const inPlaceEditor = /\b(?:sed\s+(?:-[^\s]*i[^\s]*|--in-place)|perl\s+-[^\s]*i[^\s]*)\b/i.test(command);
  const scriptWriter = /\b(?:writeFile(?:Sync)?|write_text|write_bytes)\s*\(|\bopen\s*\([^\n,]+,[^\n]*(?:['"]w['"]|['"]a['"])/i.test(command);
  const explicitFileApi = /\b(?:fs\.|Deno\.|Bun\.)write(?:File|TextFile)|\bFile\.write\b/i.test(command);

  return shellAuthor || inPlaceEditor || scriptWriter || explicitFileApi;
}

export default function fileToolDiscipline(pi: ExtensionAPI) {
  pi.on(PI_EVENT.BEFORE_AGENT_START, (event, ctx) => {
    if (!isGpt(ctx) || !hasFileTools(pi)) return;
    return { systemPrompt: `${event.systemPrompt}\n\n${FILE_POLICY}` };
  });

  pi.on(PI_EVENT.TOOL_CALL, (event, ctx) => {
    if (!isGpt(ctx) || !hasFileTools(pi)) return;
    if (event.toolName !== TOOL_BASH && event.toolName !== TOOL_POWERSHELL) return;
    const command = (event.input as { command?: unknown })?.command;
    if (typeof command !== "string" || !directlyAuthorsFile(event.toolName, command)) return;

    return {
      block: true,
      reason: BLOCK_REASON,
    };
  });
}
