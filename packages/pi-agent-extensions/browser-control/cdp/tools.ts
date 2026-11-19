// Tools layer for the CDP browser-control extension.
// Registers the 13 contract tools; every call delegates to controller.call(agent, name, params, { signal, onProgress })
// with params passed through verbatim. Results are mapped, never thrown: OkResult -> text
// content (+ image block for screenshot); StopResult/ErrorResult -> text = message,
// details = the result object itself, so the agent reads the STOP/error verbatim.
// Controller progress is forwarded as tool updates whose details carry a `runtimeEvent`, which the
// execution runtime (runtime/runtime.ts) turns into computer.action / computer.observation events.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { TOOL_NAMES, type ActionResult, type Controller, type ControllerProgress, type ToolName } from "./contract.ts";

export type GetController = () => Promise<Controller>;

/** Agent id resolution, evaluated per call: deps.agent, then $H1_SELF, then "pi". */
export function resolveAgent(depsAgent?: () => string): string {
  return depsAgent?.() ?? process.env.H1_SELF ?? "pi";
}

export function mapResult(result: ActionResult): { content: unknown[]; details: unknown } {
  if (result.ok) {
    const content: unknown[] = [{ type: "text", text: result.text }];
    if (!result.image) return { content, details: result };
    content.push({ type: "image", data: result.image.data, mimeType: result.image.mimeType });
    // The image already travels in content; keeping a second base64 copy in details would double the session size.
    const { image, ...rest } = result;
    return { content, details: { ...rest, image: { mimeType: image.mimeType, bytes: Math.floor(image.data.length * 3 / 4) } } };
  }
  return { content: [{ type: "text", text: result.message }], details: result };
}

const tab = Type.String({ minLength: 1 });
const ref = Type.String({ minLength: 1 });
const confirmed = Type.Optional(Type.Boolean());

const DEFS: Record<ToolName, { description: string; parameters: unknown }> = {
  tabs_list: { description: "List the browser tabs owned by this agent (targetId, url, title). The user's own tabs are never listed.", parameters: Type.Object({}) },
  tab_open: { description: "Open a new tab owned by this agent (default about:blank), wait for the page to load and return its tab id, final URL, HTTP status and title.", parameters: Type.Object({ url: Type.Optional(Type.String({ maxLength: 2048 })) }) },
  tab_close: { description: "Close a tab owned by this agent.", parameters: Type.Object({ tab }) },
  navigate: { description: "Navigate an owned tab to an http(s) URL or about:blank and wait for it to load. Fails with navigation_failed when the page cannot be loaded; reports HTTP error pages as NOT verified.", parameters: Type.Object({ tab, url: Type.String({ minLength: 1, maxLength: 2048 }) }) },
  snapshot: { description: "Accessibility snapshot of an owned tab: one node per line, interactive nodes carry stable [eN] refs for click/type/select/upload.", parameters: Type.Object({ tab }) },
  click: { description: "Click the snapshot ref in an owned tab, wait for any navigation it starts, and report the observed effect (navigation, page change, element state) or NOT verified when nothing changed. Submit-like targets require user_confirmed=true.", parameters: Type.Object({ tab, ref, user_confirmed: confirmed }) },
  type: { description: "Type text into the snapshot ref in an owned tab, replacing its current content (append=true keeps it). The result reports the field's resulting value. Password fields are always refused.", parameters: Type.Object({ tab, ref, text: Type.String({ maxLength: 16384 }), append: Type.Optional(Type.Boolean()), user_confirmed: confirmed }) },
  press: { description: "Press a key (Enter, Tab, Escape, ArrowDown, a, ...) in an owned tab. Submit-like keys require user_confirmed=true.", parameters: Type.Object({ tab, key: Type.String({ minLength: 1, maxLength: 64 }), user_confirmed: confirmed }) },
  select: { description: "Select an option (by value or visible label) in the snapshot ref in an owned tab.", parameters: Type.Object({ tab, ref, value: Type.String({ maxLength: 2048 }) }) },
  scroll: { description: "Scroll an owned tab (default 600px), optionally around a snapshot ref.", parameters: Type.Object({ tab, direction: StringEnum(["up", "down", "left", "right"] as const), amount: Type.Optional(Type.Number({ minimum: 0, maximum: 100000 })), ref: Type.Optional(ref) }) },
  upload: { description: "Upload an existing file (absolute path) through the file-input snapshot ref in an owned tab.", parameters: Type.Object({ tab, ref, file: Type.String({ minLength: 1, maxLength: 4096 }) }) },
  screenshot: { description: "Screenshot an owned tab as a PNG image block.", parameters: Type.Object({ tab }) },
  wait_for: { description: "Wait until text appears/disappears or a ref appears in an owned tab (timeout default 10000ms, max 30000ms).", parameters: Type.Object({ tab, text: Type.Optional(Type.String({ maxLength: 2048 })), ref: Type.Optional(ref), gone: Type.Optional(Type.Boolean()), timeout_ms: Type.Optional(Type.Number({ minimum: 0, maximum: 30000 })) }) },
};

const GUIDELINES = [
  "Browser tools: observe (snapshot) before acting, act on one ref at a time, and read each action's verification before the next step. A result marked NOT verified did not show the expected effect: snapshot or wait_for before claiming success.",
];

function progressText(e: ControllerProgress): string {
  if (e.kind === "progress") return e.message;
  if (e.kind === "computer.action") return e.action + " " + e.status + (e.target ? " " + e.target : "") + (e.detail ? " (" + e.detail + ")" : "");
  return (e.verified === false ? "NOT verified: " : "") + (e.evidence ?? "") + (e.url ? " @ " + e.url : "");
}

export function registerCdpTools(pi: ExtensionAPI, getController: GetController, depsAgent?: () => string): void {
  for (const name of TOOL_NAMES) {
    const def = DEFS[name];
    pi.registerTool({
      name,
      label: name,
      description: def.description,
      promptSnippet: def.description,
      promptGuidelines: GUIDELINES,
      parameters: def.parameters,
      // Browser calls in one assistant message must run in order: a snapshot issued after a click has to see the click.
      executionMode: "sequential",
      async execute(_id: string, params: never, signal: AbortSignal | undefined, onUpdate: ((u: { content: unknown[]; details: unknown }) => void) | undefined) {
        const controller = await getController();
        const onProgress = (runtimeEvent: ControllerProgress) => onUpdate?.({ content: [{ type: "text", text: progressText(runtimeEvent) }], details: { runtimeEvent } });
        const result = await controller.call(resolveAgent(depsAgent), name, params as never, { signal, onProgress });
        return mapResult(result);
      },
    } as never);
  }
}
