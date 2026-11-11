// Tools layer for the CDP browser-control extension (bc_tools).
// Registers the 13 contract tools; every call delegates to controller.call(agent, name, params)
// with params passed through verbatim. Results are mapped, never thrown: OkResult -> text
// content (+ image block for screenshot); StopResult/ErrorResult -> text = message,
// details = the result object itself, so the agent reads the STOP/error verbatim.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { TOOL_NAMES, type ActionResult, type Controller, type ToolName } from "./contract.ts";

export type GetController = () => Promise<Controller>;

/** Agent id resolution, evaluated per call: deps.agent, then $H1_SELF, then "pi". */
export function resolveAgent(depsAgent?: () => string): string {
  return depsAgent?.() ?? process.env.H1_SELF ?? "pi";
}

export function mapResult(result: ActionResult): { content: unknown[]; details: ActionResult } {
  if (result.ok) {
    const content: unknown[] = [{ type: "text", text: result.text }];
    if (result.image) content.push({ type: "image", data: result.image.data, mimeType: result.image.mimeType });
    return { content, details: result };
  }
  return { content: [{ type: "text", text: result.message }], details: result };
}

const tab = Type.String({ minLength: 1 });
const ref = Type.String({ minLength: 1 });
const confirmed = Type.Optional(Type.Boolean());

const DEFS: Record<ToolName, { description: string; parameters: unknown }> = {
  tabs_list: { description: "List the browser tabs owned by this agent (targetId, url, title). The user's own tabs are never listed.", parameters: Type.Object({}) },
  tab_open: { description: "Open a new tab owned by this agent (default about:blank) and return its tab id.", parameters: Type.Object({ url: Type.Optional(Type.String({ maxLength: 2048 })) }) },
  tab_close: { description: "Close a tab owned by this agent.", parameters: Type.Object({ tab }) },
  navigate: { description: "Navigate an owned tab to an http(s) URL or about:blank.", parameters: Type.Object({ tab, url: Type.String({ minLength: 1, maxLength: 2048 }) }) },
  snapshot: { description: "Accessibility snapshot of an owned tab: one node per line, interactive nodes carry stable [eN] refs for click/type/select/upload.", parameters: Type.Object({ tab }) },
  click: { description: "Click the snapshot ref in an owned tab. Submit-like targets require user_confirmed=true.", parameters: Type.Object({ tab, ref, user_confirmed: confirmed }) },
  type: { description: "Type text into the snapshot ref in an owned tab. Password fields are always refused.", parameters: Type.Object({ tab, ref, text: Type.String({ maxLength: 16384 }), user_confirmed: confirmed }) },
  press: { description: "Press a key (Enter, Tab, Escape, ArrowDown, a, ...) in an owned tab. Submit-like keys require user_confirmed=true.", parameters: Type.Object({ tab, key: Type.String({ minLength: 1, maxLength: 64 }), user_confirmed: confirmed }) },
  select: { description: "Select an option (by value or visible label) in the snapshot ref in an owned tab.", parameters: Type.Object({ tab, ref, value: Type.String({ maxLength: 2048 }) }) },
  scroll: { description: "Scroll an owned tab (default 600px), optionally around a snapshot ref.", parameters: Type.Object({ tab, direction: StringEnum(["up", "down", "left", "right"] as const), amount: Type.Optional(Type.Number({ minimum: 0, maximum: 100000 })), ref: Type.Optional(ref) }) },
  upload: { description: "Upload an existing file (absolute path) through the file-input snapshot ref in an owned tab.", parameters: Type.Object({ tab, ref, file: Type.String({ minLength: 1, maxLength: 4096 }) }) },
  screenshot: { description: "Screenshot an owned tab as a PNG image block.", parameters: Type.Object({ tab }) },
  wait_for: { description: "Wait until text appears/disappears or a ref appears in an owned tab (timeout default 10000ms, max 30000ms).", parameters: Type.Object({ tab, text: Type.Optional(Type.String({ maxLength: 2048 })), ref: Type.Optional(ref), gone: Type.Optional(Type.Boolean()), timeout_ms: Type.Optional(Type.Number({ minimum: 0, maximum: 30000 })) }) },
};

export function registerCdpTools(pi: ExtensionAPI, getController: GetController, depsAgent?: () => string): void {
  for (const name of TOOL_NAMES) {
    const def = DEFS[name];
    pi.registerTool({
      name,
      label: name,
      description: def.description,
      promptSnippet: def.description,
      parameters: def.parameters,
      async execute(_id: string, params: never) {
        const controller = await getController();
        const result = await controller.call(resolveAgent(depsAgent), name, params as never);
        return mapResult(result);
      },
    } as never);
  }
}
