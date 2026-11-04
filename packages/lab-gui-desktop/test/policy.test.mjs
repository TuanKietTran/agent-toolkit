import assert from "node:assert/strict";
import test from "node:test";
import { WINDOW_OPTIONS, canNavigate, isOwnRequest } from "../lib/policy.mjs";

const origin = "http://127.0.0.1:4555";

test("only the local server and inline images may be requested", () => {
  assert.ok(isOwnRequest(origin, `${origin}/app.js`));
  assert.ok(isOwnRequest(origin, `${origin}/api/stream`));
  assert.ok(isOwnRequest(origin, "data:image/svg+xml;base64,AAAA"));
  for (const bad of ["https://example.com/x.js", "http://127.0.0.1:9999/", "http://localhost:4555/", "file:///etc/passwd", "ws://127.0.0.1:4555/", "devtools://devtools/x", "not a url"]) assert.ok(!isOwnRequest(origin, bad), bad);
});

test("navigation stays on the app's origin", () => {
  assert.ok(canNavigate(origin, `${origin}/?key=abc`));
  assert.ok(!canNavigate(origin, "https://example.com/"));
  assert.ok(!canNavigate(origin, "javascript:alert(1)"));
  assert.ok(!canNavigate(origin, "garbage"));
});

test("the window is sandboxed with no Node access", () => {
  const p = WINDOW_OPTIONS.webPreferences;
  assert.equal(p.contextIsolation, true);
  assert.equal(p.nodeIntegration, false);
  assert.equal(p.sandbox, true);
  assert.equal(p.webSecurity, true);
  assert.equal(p.devTools, false);
  assert.equal(WINDOW_OPTIONS.show, false, "the window is shown only once it has painted");
});
