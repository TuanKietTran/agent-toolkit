import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const dir = fileURLToPath(new URL("../public/", import.meta.url));
const files = readdirSync(dir).map((name) => [name, readFileSync(join(dir, name), "utf8")]);

test("the page needs no inline styles, inline scripts or external hosts (its CSP forbids them)", () => {
  for (const [name, text] of files) {
    if (name.endsWith(".js") || name.endsWith(".html")) {
      assert.doesNotMatch(text, /\sstyle\s*=\s*["']/, `${name}: style attribute`);
      assert.doesNotMatch(text, /setAttribute\(\s*["']style["']/, `${name}: setAttribute style`);
      assert.doesNotMatch(text, /innerHTML|outerHTML|insertAdjacentHTML|document\.write|eval\(/, `${name}: HTML injection sink`);
    }
    if (name.endsWith(".html")) assert.doesNotMatch(text, /<script(?![^>]*\bsrc=)/, "inline script");
    assert.doesNotMatch(text.replace(/http:\/\/www\.w3\.org\/2000\/svg/g, ""), /https?:\/\//, `${name}: external URL`);
  }
});

test("every id the script looks up exists in the page", () => {
  const html = files.find(([n]) => n === "index.html")[1];
  const js = files.find(([n]) => n === "app.js")[1];
  const ids = new Set([...js.matchAll(/\$\("([\w-]+)"\)/g)].map((m) => m[1]));
  for (const id of ids) assert.match(html, new RegExp(`id="${id}"`), `missing #${id}`);
});
