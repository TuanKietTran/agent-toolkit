// Manual, interactive tool harness. Only executes the explicit steps supplied by the operator.
// node browser-control/tests/live-windows.ts steps.json [artifact-directory]
// steps.json: [{"tool":"win_browser_observe","params":{}}, ...]
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import browserControl from "../index.ts";

if (process.platform !== "win32") throw new Error("This live harness requires Windows and an already-running browser");
const steps = JSON.parse(await readFile(process.argv[2], "utf8")) as { tool: string; params: Record<string, unknown> }[];
const directory = resolve(process.argv[3] || ".build/windows-live");
await mkdir(directory, { recursive: true });
const exec = promisify(execFile);
const tools = new Map<string, { execute: Function }>();
const pi = {
  registerTool(tool: { name: string; execute: Function }) { tools.set(tool.name, tool); },
  registerCommand() {}, on() {}, appendEntry() {},
  async exec(command: string, args: string[], options: { timeout?: number; signal?: AbortSignal }) {
    try { return { code: 0, ...await exec(command, args, { ...options, encoding: "utf8", windowsHide: true, maxBuffer: 4 * 1024 * 1024 }) }; }
    catch (error) { const e = error as { code?: number; stdout?: string; stderr?: string; message: string }; return { code: e.code ?? 1, stdout: e.stdout ?? "", stderr: e.stderr || e.message }; }
  },
} as unknown as ExtensionAPI;
browserControl(pi);
for (let index = 0; index < steps.length; index++) {
  const step = steps[index];
  const tool = tools.get(step.tool);
  if (!tool) throw new Error(`Unknown tool: ${step.tool}`);
  const result = await tool.execute(`live-${index}`, step.params, undefined, undefined, {});
  for (const block of result.content) {
    if (block.type === "text") console.log(step.tool, block.text);
    else if (block.type === "image") {
      const path = join(directory, `${index}-${step.tool}.png`);
      await writeFile(path, Buffer.from(block.data, "base64")); console.log("SCREENSHOT", path);
    }
  }
}
