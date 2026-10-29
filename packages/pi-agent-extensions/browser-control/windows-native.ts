import { createHash } from "node:crypto";
import { existsSync, writeFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rename, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export type Exec = (command: string, args: string[], options: { signal?: AbortSignal; timeout: number }) => Promise<{ code: number; stdout: string; stderr: string }>;
const source = join(dirname(fileURLToPath(import.meta.url)), "native", "windows-controller.cs");

export class WindowsNative {
  private binary?: Promise<string>;
  private exec: Exec;
  constructor(exec: Exec) { this.exec = exec; }

  helper(): Promise<string> {
    if (process.platform !== "win32") return Promise.reject(new Error("Windows browser control requires Windows"));
    return this.binary ??= this.compile().catch((error) => { this.binary = undefined; throw error; });
  }

  private async compile(): Promise<string> {
    const digest = createHash("sha256").update(await readFile(source)).digest("hex").slice(0, 20);
    const cache = join(process.env.LOCALAPPDATA || join(homedir(), "AppData", "Local"), "pi-browser-control", digest);
    const binary = join(cache, "windows-controller.exe");
    if (existsSync(binary)) return binary;
    await mkdir(cache, { recursive: true });
    const framework = join(process.env.WINDIR || "C:\\Windows", process.arch === "ia32" ? "Microsoft.NET/Framework/v4.0.30319" : "Microsoft.NET/Framework64/v4.0.30319");
    const compiler = join(framework, "csc.exe");
    if (!existsSync(compiler)) throw new Error("Windows browser control requires the Windows .NET Framework 4.x C# compiler");
    const temporary = join(cache, `controller-${process.pid}-${Date.now()}.exe`);
    try {
      const result = await this.exec(compiler, ["/nologo", "/target:exe", "/optimize+", `/out:${temporary}`,
        "/reference:System.Drawing.dll", "/reference:System.Web.Extensions.dll",
        `/reference:${join(framework, "WPF", "UIAutomationClient.dll")}`,
        `/reference:${join(framework, "WPF", "UIAutomationTypes.dll")}`,
        `/reference:${join(framework, "WPF", "WindowsBase.dll")}`, source], { timeout: 60_000 });
      if (result.code !== 0) throw new Error(`Could not compile Windows browser helper: ${result.stderr || result.stdout}`);
      try { await rename(temporary, binary); } catch (error) { if (!existsSync(binary)) throw error; }
      return binary;
    } finally { await rm(temporary, { force: true }); }
  }

  async run<T>(request: Record<string, unknown>, signal?: AbortSignal, timeout = 30_000): Promise<T> {
    signal?.throwIfAborted();
    const binary = await this.helper();
    signal?.throwIfAborted();
    // Do not kill an input process between key/button down and up. Cooperative cancellation
    // lets its finally blocks release synthetic modifiers/buttons before we report an abort.
    const input = request.expected === true;
    const directory = input ? await mkdtemp(join(tmpdir(), "pi-win-browser-cancel-")) : undefined;
    const cancel = directory ? join(directory, "cancel") : undefined;
    const abort = () => { if (cancel) writeFileSync(cancel, ""); };
    try {
      signal?.addEventListener("abort", abort, { once: true });
      signal?.throwIfAborted();
      const encoded = Buffer.from(JSON.stringify({ ...request, cancel_file: cancel })).toString("base64");
      if (encoded.length > 28_000) throw new Error("Native browser request exceeds Windows command-line limit");
      const result = await this.exec(binary, [encoded], { signal: input ? undefined : signal, timeout });
      signal?.throwIfAborted();
      if (result.code !== 0) throw new Error((result.stderr || result.stdout).trim() || "Windows browser helper failed or timed out");
      return JSON.parse(result.stdout.replace(/^\uFEFF/, "").trim()) as T;
    } finally {
      signal?.removeEventListener("abort", abort);
      if (directory) await rm(directory, { recursive: true, force: true });
    }
  }
}
