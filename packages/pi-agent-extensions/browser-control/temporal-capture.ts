import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export type CapturedFrame = { bytes: Buffer; at: number; title: string };
export type TemporalArtifacts = { gif: string; contactSheet: string; image: string; frameTimesMs: number[] };

/** Keep a baseline and a bounded, chronological sampling of the navigation, including transient frames. */
export class TemporalCapture {
  private frames: CapturedFrame[] = [];
  private readonly startedAt = Date.now();

  add(bytes: Buffer, title: string, changed = false): void {
    const at = Date.now() - this.startedAt;
    const previous = this.frames.at(-1);
    if (previous && !changed && at - previous.at < 350) return;
    if (previous && previous.bytes.equals(bytes) && previous.title === title) return;
    this.frames.push({ bytes, at, title });
    if (this.frames.length > 12) this.frames.splice(1, 1);
  }

  async render(exec: (args: string[]) => Promise<{ code: number; stderr: string }>): Promise<TemporalArtifacts> {
    if (!this.frames.length) throw new Error("No browser frames were recorded");
    const directory = await mkdtemp(join(tmpdir(), "pi-mac-browser-clip-"));
    await Promise.all(this.frames.map((frame, index) => writeFile(join(directory, `frame-${String(index).padStart(3, "0")}.jpg`), frame.bytes)));
    const input = join(directory, "frame-%03d.jpg");
    const gif = join(directory, "browser.gif");
    const contactSheet = join(directory, "contact-sheet.jpg");
    const columns = this.frames.length <= 4 ? 2 : 3;
    const rows = Math.ceil(this.frames.length / columns);
    const commands = [
      ["-hide_banner", "-loglevel", "error", "-framerate", "3", "-i", input, "-vf", "scale=960:-1:flags=lanczos", "-loop", "0", "-y", gif],
      ["-hide_banner", "-loglevel", "error", "-framerate", "3", "-i", input, "-vf", `scale=420:-1:flags=lanczos,tile=${columns}x${rows}:padding=4:margin=4`, "-frames:v", "1", "-y", contactSheet],
    ];
    for (const args of commands) {
      const result = await exec(args);
      if (result.code !== 0) throw new Error(`ffmpeg temporal capture failed: ${result.stderr.trim()}`);
    }
    return { gif, contactSheet, image: (await readFile(contactSheet)).toString("base64"), frameTimesMs: this.frames.map((frame) => frame.at) };
  }
}
