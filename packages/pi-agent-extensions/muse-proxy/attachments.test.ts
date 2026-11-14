import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { imageSurrogate, inlineAttachments, MAX_DESCRIPTION_CHARS } from "./attachments.ts";

const png = { type: "image", data: Buffer.alloc(2048).toString("base64"), mimeType: "image/png" };

test("surrogate has a header and the description", () => {
  const text = imageSurrogate({ data: png.data, mimeType: "image/png" }, "hello");
  assert.match(text, /^\[Attached image: image\/png, 2\.0 KB/);
  assert.match(text, /\nhello$/);
});

test("surrogate says so when nothing was extracted, and clips long text", () => {
  assert.match(imageSurrogate({ data: "AAAA", mimeType: "image/png" }, undefined), /no text could be extracted/);
  const long = imageSurrogate({ data: "AAAA", mimeType: "image/png" }, "x".repeat(MAX_DESCRIPTION_CHARS * 3));
  assert.ok(long.length < MAX_DESCRIPTION_CHARS + 300);
});

test("inlineAttachments replaces images, keeps text and message count, and caches", async () => {
  let calls = 0;
  const describe = async () => (++calls, "desc");
  const messages = [
    { role: "user", content: [{ type: "text", text: "look" }, png] },
    { role: "user", content: "plain" },
    { role: "toolResult", content: [png] },
  ];
  const out = await inlineAttachments(messages, describe);
  assert.equal(out.length, 3);
  assert.equal(out[1], messages[1]);
  const first = out[0].content as { type: string; text?: string }[];
  assert.deepEqual(first.map((b) => b.type), ["text", "text"]);
  assert.match(first[1].text!, /desc/);
  assert.equal(calls, 1); // same bytes described once
  assert.ok(!JSON.stringify(out).includes(png.data));
});

test("a failing describer still yields a header-only surrogate", async () => {
  const out = await inlineAttachments([{ role: "user", content: [{ type: "image", data: "QUJD", mimeType: "image/jpeg" }] }], async () => { throw new Error("boom"); });
  assert.match((out[0].content as any[])[0].text, /no text could be extracted/);
});

test("an image file path in user text gets a surrogate; unknown paths and other roles are left alone", async () => {
  const dir = mkdtempSync(join(tmpdir(), "muse-test-"));
  const file = join(dir, "pi-clipboard-1.png");
  writeFileSync(file, Buffer.alloc(300, 7));
  const describe = async () => "OCR TEXT";
  const out = await inlineAttachments(
    [
      { role: "user", content: `${file} what is this? also /nope/missing.png` },
      { role: "user", content: [{ type: "text", text: `see ${file}.` }] },
      { role: "assistant", content: `I looked at ${file}` },
    ],
    describe,
  );
  assert.match(out[0].content as string, /what is this\? also \/nope\/missing\.png\n\n\[Attached image file .*pi-clipboard-1\.png: image\/png/);
  assert.match(out[0].content as string, /OCR TEXT/);
  assert.match((out[1].content as any[])[0].text, /OCR TEXT/);
  assert.equal(out[2].content, `I looked at ${file}`);
});
