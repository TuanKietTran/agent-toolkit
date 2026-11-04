import assert from "node:assert/strict";
import test from "node:test";
import { startGui } from "../lib/serve.mjs";
import { TEAM, createFakeCli } from "./fakes.mjs";

test("startGui binds loopback, hands out a keyed link and serves nothing without the key", async () => {
  const gui = await startGui({ cli: createFakeCli(TEAM), pollMs: 20, idleMs: 100 });
  try {
    assert.match(gui.url, /^http:\/\/127\.0\.0\.1:\d+\/\?key=[0-9a-f]{48}$/);
    assert.equal(gui.origin, `http://127.0.0.1:${gui.port}`);
    assert.equal((await fetch(`${gui.origin}/api/labs`)).status, 401);
    const redirect = await fetch(gui.url, { redirect: "manual" });
    assert.equal(redirect.status, 302);
    const cookie = redirect.headers.get("set-cookie").split(";")[0];
    const snap = await (await fetch(`${gui.origin}/api/labs`, { headers: { cookie } })).json();
    assert.equal(snap.labs.length, 3);
  } finally {
    await gui.close();
  }
});

test("two instances get different keys and ports", async () => {
  const [a, b] = await Promise.all([startGui({ cli: createFakeCli([]) }), startGui({ cli: createFakeCli([]) })]);
  try {
    assert.notEqual(a.port, b.port);
    assert.notEqual(new URL(a.url).searchParams.get("key"), new URL(b.url).searchParams.get("key"));
  } finally {
    await Promise.all([a.close(), b.close()]);
  }
});
