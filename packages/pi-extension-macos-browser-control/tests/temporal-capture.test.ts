import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { TemporalCapture } from "../extensions/temporal-capture.ts";

test("renders a chronological multi-frame contact sheet and animated GIF", async () => {
  const directory = await mkdtemp(join(tmpdir(), "browser-clip-test-"));
  try {
    const clip = new TemporalCapture();
    for (const color of ["red", "black", "green"]) {
      const file = join(directory, `${color}.jpg`);
      const generated = spawnSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", `color=c=${color}:s=320x200`, "-frames:v", "1", "-y", file]);
      assert.equal(generated.status, 0, generated.stderr.toString());
      clip.add(await readFile(file), color, true);
    }
    const artifacts = await clip.render(async (args) => {
      const result = spawnSync("ffmpeg", args);
      return { code: result.status ?? 1, stderr: result.stderr.toString() };
    });
    assert.equal(artifacts.frameTimesMs.length, 3);
    assert.ok((await readFile(artifacts.contactSheet)).length > 0);
    assert.ok((await readFile(artifacts.gif)).length > 0);
    const frames = spawnSync("ffprobe", ["-v", "error", "-count_frames", "-select_streams", "v:0", "-show_entries", "stream=nb_read_frames", "-of", "default=noprint_wrappers=1:nokey=1", artifacts.gif]);
    assert.equal(frames.stdout.toString().trim(), "3");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
