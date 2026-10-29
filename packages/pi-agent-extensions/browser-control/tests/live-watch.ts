import { spawn } from "node:child_process";
import browserExtension from "../extensions/macos-browser-control.ts";

const tools = new Map<string, any>();
let finish: (value: unknown) => void;
const event = new Promise<unknown>((resolve) => { finish = resolve; });
const pi = {
  registerTool(tool: any) { tools.set(tool.name, tool); },
  registerCommand() {},
  on() {},
  sendUserMessage(content: any) {
    const parts = typeof content === "string" ? [{ type: "text", text: content }] : content;
    const metadata = JSON.parse(parts.find((part: any) => part.type === "text").text);
    console.log(JSON.stringify({ ...metadata, image_bytes: parts.find((part: any) => part.type === "image")?.data.length ?? 0 }));
    finish(metadata);
  },
  exec(command: string, args: string[], options: any = {}) {
    return new Promise<{ code: number; stdout: string; stderr: string }>((resolve, reject) => {
      const child = spawn(command, args, { signal: options.signal });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (part) => { stdout += part; });
      child.stderr.on("data", (part) => { stderr += part; });
      child.on("error", reject);
      child.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
    });
  },
};

browserExtension(pi as any);
const ctx = { modelRegistry: {}, sessionManager: { getBranch: () => [] }, ui: {}, hasUI: false };
const watch = tools.get("mac_browser_watch");
console.log(JSON.stringify((await watch.execute("live", { action: "start", assess: false }, undefined, undefined, ctx)).content));
await Promise.race([event, new Promise((_, reject) => setTimeout(() => reject(new Error("No browser change within 30 seconds")), 30_000))]);
