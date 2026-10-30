import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import net from "node:net";
import { randomUUID } from "node:crypto";

const installer = fileURLToPath(new URL("../install.mjs", import.meta.url));
const extensionId = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const csc = "C:/Windows/Microsoft.NET/Framework64/v4.0.30319/csc.exe";
const pipeName = `\\\\.\\pipe\\pi-browser-bridge-${randomUUID().replace(/-/g, "").slice(0, 32)}`;
function invoke(args) {
  const result = spawnSync(process.execPath, [installer, ...args], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}
function encodeFrame(value) { const body = Buffer.from(JSON.stringify(value)); const head = Buffer.alloc(4); head.writeUInt32LE(body.length); return Buffer.concat([head, body]); }
async function waitPipe(name, child, timeout = 5000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (child.exitCode !== null) throw new Error(`broker exited: ${child.exitCode}`);
    const connected = await new Promise(resolveConnect => {
      const pipe = net.createConnection(name); pipe.once("connect", () => resolveConnect(pipe)); pipe.once("error", () => resolveConnect(null));
    });
    if (connected) return connected;
    await new Promise(r => setTimeout(r, 20));
  }
  throw new Error("Timed out waiting for secured named pipe");
}
function muxEchoHost() {
  return `let b=Buffer.alloc(0);process.stdin.on('data',c=>{b=Buffer.concat([b,c]);while(b.length>=4){const n=b.readUInt32LE(0);if(b.length<n+4)return;const m=JSON.parse(b.subarray(4,n+4));b=b.subarray(n+4);let r;if(m.type==='data')r={v:1,type:'data',peer:m.peer,bytes:m.bytes};else if(m.type!=='open'&&m.type!=='close')process.exit(9);if(r){const d=Buffer.from(JSON.stringify(r));const h=Buffer.alloc(4);h.writeUInt32LE(d.length);process.stdout.write(Buffer.concat([h,d]));}}});`;
}

test("dry-run writes nothing and does not invent an extension id", async () => {
  const fixture = await mkdtemp(join(tmpdir(), "pi-bridge-package-"));
  try {
    const output = invoke(["--dry-run", "--fixture", fixture, "--pipe-name", pipeName]);
    assert.equal(output.writesNothing, true);
    assert.equal(output.browser, "brave");
    assert.equal(output.manifestPath, join(fixture, "NativeMessagingHosts", "brave", "com.pi_agent_extensions.browser_bridge.json"));
    if (process.platform === "win32") assert.match(output.registration, /BraveSoftware\\Brave-Browser/);
    assert.match(output.manifest.allowed_origins[0], /SET_EXACT_32_CHAR_EXTENSION_ID/);
    const chrome = invoke(["--dry-run", "--fixture", fixture, "--browser", "chrome", "--pipe-name", pipeName]);
    assert.equal(chrome.browser, "chrome");
    assert.equal(chrome.manifestPath, join(fixture, "NativeMessagingHosts", "chrome", "com.pi_agent_extensions.browser_bridge.json"));
    if (process.platform === "win32") assert.match(chrome.registration, /Software\\Google\\Chrome/);
    assert.deepEqual(await readdir(fixture), []);
  } finally { await rm(fixture, { recursive: true, force: true }); }
});

test("fixture installer writes path-only manifest and owner config; uninstall removes fixture files", async () => {
  const fixture = await mkdtemp(join(tmpdir(), "pi-bridge-package-"));
  try {
    const output = invoke(["--install", "--fixture", fixture, "--extension-id", extensionId, "--pipe-name", pipeName, "--csc", csc]);
    const manifest = JSON.parse(await readFile(output.manifestPath, "utf8"));
    assert.equal(manifest.name, "com.pi_agent_extensions.browser_bridge");
    assert.equal(manifest.type, "stdio");
    assert.deepEqual(Object.keys(manifest).sort(), ["allowed_origins", "description", "name", "path", "type"]);
    assert.equal(manifest.path, join(fixture, "PiBrowserBridge", "bridge-host.exe"));
    assert.deepEqual(manifest.allowed_origins, [`chrome-extension://${extensionId}/`]);
    const config = JSON.parse(await readFile(join(fixture, "PiBrowserBridge", "host-config.json")));
    assert.deepEqual(config, { nodeExecutable: process.execPath, hostScript: resolve(dirname(installer), "bridge-host.mjs"), pipeName, extensionOrigin: `chrome-extension://${extensionId}/` });
    invoke(["--uninstall", "--fixture", fixture, "--pipe-name", pipeName]);
    await assert.rejects(readFile(output.manifestPath));
  } finally { await rm(fixture, { recursive: true, force: true }); }
});

test("manifest.path runs the real Node native host and returns ready plus broker-assigned target catalog", { skip: process.platform !== "win32" }, async t => {
  const nativeHost = process.env.PI_BROWSER_BRIDGE_HOST_SCRIPT ?? resolve(dirname(installer), "bridge-host.mjs");
  try { await readFile(nativeHost); } catch { t.skip(`transport-owned real bridge-host.mjs not present: ${nativeHost}`); return; }
  const { encodeNativeFrame, decodeNativeFrame } = await import("../../helper-extension/native-frame.mjs");
  const fixture = await mkdtemp(join(tmpdir(), "pi bridge native "));
  const relayPipe = `\\\\.\\pipe\\pi-browser-bridge-${randomUUID().replace(/-/g, "").slice(0, 32)}`;
  const installed = invoke(["--install", "--fixture", fixture, "--extension-id", extensionId, "--pipe-name", relayPipe, "--node", process.execPath, "--host-script", nativeHost, "--csc", csc]);
  const manifest = JSON.parse(await readFile(installed.manifestPath, "utf8"));
  const config = join(fixture, "PiBrowserBridge", "host-config.json");
  const broker = spawn(manifest.path, ["--broker", "--config", config], { stdio: ["ignore", "ignore", "pipe"] });
  let nativeProcess, readinessProbe, diagnostics = "";
  broker.stderr.on("data", d => { diagnostics += d; });
  t.after(async () => {
    if (nativeProcess && nativeProcess.exitCode === null) { nativeProcess.kill(); await new Promise(r => nativeProcess.once("exit", r)); }
    if (readinessProbe && !readinessProbe.destroyed) { readinessProbe.destroy(); await new Promise(resolveClose => readinessProbe.once("close", resolveClose)); }
    if (broker.exitCode === null) { broker.kill(); await new Promise(r => broker.once("exit", r)); }
    await rm(fixture, { recursive: true, force: true });
  });
  readinessProbe = await waitPipe(relayPipe, broker);
  assert.equal(broker.exitCode, null, `broker failed before native launch: ${diagnostics}`);
  const native = nativeProcess = spawn(manifest.path, [`chrome-extension://${extensionId}/`], { stdio: ["pipe", "pipe", "pipe"] });
  let buffered = Buffer.alloc(0), messages = [], wake;
  native.stdout.on("data", chunk => {
    buffered = Buffer.concat([buffered, chunk]);
    while (buffered.length >= 4 && buffered.length >= buffered.readUInt32LE(0) + 4) {
      const size = buffered.readUInt32LE(0), frame = buffered.subarray(0, size + 4); buffered = buffered.subarray(size + 4);
      messages.push(decodeNativeFrame(new Uint8Array(frame))); wake?.(); wake = undefined;
    }
  });
  let nativeDiagnostics = ""; native.stderr.on("data", chunk => { nativeDiagnostics += chunk; });
  const receive = async type => {
    const end = Date.now() + 8000;
    while (Date.now() < end) {
      const index = messages.findIndex(message => message.type === type);
      if (index >= 0) return messages.splice(index, 1)[0];
      await Promise.race([new Promise(resolveWait => { wake = resolveWait; }), new Promise(resolveWait => setTimeout(resolveWait, 50))]);
      if (native.exitCode !== null) break;
    }
    throw new Error(`Timed out waiting for ${type}; messages=${JSON.stringify(messages)} native=${nativeDiagnostics} broker=${diagnostics}`);
  };
  native.stdin.write(encodeNativeFrame({ type: "hello", version: 1 }));
  const ready = await receive("ready");
  assert.equal(ready.version, 1);
  await receive("targetsRequest");
  native.stdin.write(encodeNativeFrame({ type: "targetInventory", session: ready.session, tabs: [{ tabId: 17, origin: "https://example.test", title: "fixture tab" }] }));
  const catalog = await receive("targets");
  assert.equal(catalog.targets.length, 1);
  assert.deepEqual({ tabId: catalog.targets[0].tabId, origin: catalog.targets[0].origin, title: catalog.targets[0].title }, { tabId: 17, origin: "https://example.test", title: "fixture tab" });
  assert.notEqual(catalog.targets[0].id, "17", "broker assigns opaque target IDs");
  native.stdin.end();
});

test("broker fails closed if its pipe name was pre-created", { skip: process.platform !== "win32" }, async () => {
  const fixture = await mkdtemp(join(tmpdir(), "pi bridge squat "));
  const tree = join(fixture, "browser-control", "native-host"); await mkdir(tree, { recursive: true });
  const nodeHost = join(tree, "bridge-host.mjs"); await writeFile(nodeHost, muxEchoHost());
  const squatPipe = `\\\\.\\pipe\\pi-browser-bridge-${randomUUID().replace(/-/g, "").slice(0, 32)}`;
  try {
    const installed = invoke(["--install", "--fixture", fixture, "--extension-id", extensionId, "--pipe-name", squatPipe, "--node", process.execPath, "--host-script", nodeHost, "--csc", csc]);
    const pipeShort = squatPipe.slice("\\\\.\\pipe\\".length);
    const readyFile = join(fixture, "squat-ready.txt");
    const ps = join(fixture, "hold-pipe.ps1");
    await writeFile(ps, `$p=[System.IO.Pipes.NamedPipeServerStream]::new('${pipeShort}',[System.IO.Pipes.PipeDirection]::InOut,1,[System.IO.Pipes.PipeTransmissionMode]::Byte,[System.IO.Pipes.PipeOptions]::None);Set-Content -LiteralPath '${readyFile}' -Value ready;Start-Sleep -Seconds 20;$p.Dispose()`);
    const powershell = spawn("C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", ps], { stdio: "ignore" });
    for (let i = 0; i < 100 && !(await import("node:fs/promises").then(fs => fs.access(readyFile).then(() => true, () => false))); i++) await new Promise(r => setTimeout(r, 20));
    try {
      const blocked = spawnSync(installed.manifestPath, ["--broker", "--config", join(fixture, "PiBrowserBridge", "host-config.json")], { encoding: "utf8", timeout: 5000 });
      assert.notEqual(blocked.status, 0, "first-instance creation must fail closed on a pre-created pipe");
    } finally { powershell.kill(); }
  } finally { await rm(fixture, { recursive: true, force: true }); }
});

test("installer rejects guessed or malformed extension IDs without writing", async () => {
  const fixture = await mkdtemp(join(tmpdir(), "pi-bridge-package-"));
  try {
    const result = spawnSync(process.execPath, [installer, "--install", "--fixture", fixture, "--extension-id", "placeholder", "--pipe-name", pipeName], { encoding: "utf8" });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Invalid Chromium extension ID/);
    assert.deepEqual(await readdir(fixture), []);
  } finally { await rm(fixture, { recursive: true, force: true }); }
});
