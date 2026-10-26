import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { networkInterfaces } from "node:os";
import { PI_EVENT } from "./core/events.ts";

// --- Constants: every local literal lives here. ---

const STATE_KEY = Symbol.for("pi.remote-control.state.v1");
const COMMAND_NAME = "remote-control";
const COMMAND_DESCRIPTION = "Start, stop, or show the secure browser remote for this Pi session";
const STATUS_KEY = "remote-control";
const ACTION_START = "start";
const ACTION_STOP = "stop";
const ACTION_STATUS = "status";
const ACTION_LOCAL = "local";
const QUIT = "quit";
const EVENT_SYNC = "sync";
const EVENT_DELTA = "delta";
const EVENT_TOOL = "tool";
const UPDATE_TEXT_DELTA = "text_delta";
const PHASE_START = "start";
const PHASE_END = "end";
const NOTE_INFO = "info";
const NOTE_WARNING = "warning";
const NOTE_ERROR = "error";
const WIDGET_PLACEMENT = "aboveEditor";
const PLATFORM_MACOS = "darwin";
const CLIPBOARD_COMMAND = "pbcopy";
const MODEL_NAME = "pi-session";
const STATUS_ENABLED = "remote: on";
const NOTE_STOPPED = "Remote control stopped";
const NOTE_NOT_RUNNING = "Remote control is stopped";
const NOTE_USAGE = "Usage: /remote-control [start|local|status|stop]";

type Client = ServerResponse<IncomingMessage>;
type Completion = {
  id: string;
  response: ServerResponse;
  stream: boolean;
  created: number;
  text: string;
  heartbeat?: ReturnType<typeof setInterval>;
};
type RemoteState = {
  api?: ExtensionAPI;
  ctx?: ExtensionContext;
  server?: Server;
  tunnel?: ChildProcessWithoutNullStreams;
  port?: number;
  publicUrl?: string;
  token: string;
  clients: Set<Client>;
  completions: Set<Completion>;
  busy: boolean;
};

const globals = globalThis as typeof globalThis & { [STATE_KEY]?: RemoteState };
const state: RemoteState = globals[STATE_KEY] ?? {
  token: randomBytes(32).toString("base64url"),
  clients: new Set(),
  completions: new Set(),
  busy: false,
};
state.completions ??= new Set();
globals[STATE_KEY] = state;

function json(res: ServerResponse, status: number, value: unknown): void {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(JSON.stringify(value));
}

function validToken(supplied: string): boolean {
  const a = Buffer.from(supplied), b = Buffer.from(state.token);
  return a.length === b.length && timingSafeEqual(a, b);
}

function authorized(req: IncomingMessage): boolean {
  const cookie = req.headers.cookie ?? "";
  const found = cookie.split(";").map((part) => part.trim()).find((part) => part.startsWith("pi_remote="));
  if (!found) return false;
  return validToken(decodeURIComponent(found.slice("pi_remote=".length)));
}

function apiAuthorized(req: IncomingMessage): boolean {
  const bearer = req.headers.authorization?.replace(/^Bearer\s+/i, "") ?? "";
  return validToken(bearer) || authorized(req);
}

function sameOrigin(req: IncomingMessage): boolean {
  const origin = req.headers.origin;
  if (!origin) return true;
  try {
    return new URL(origin).host === req.headers.host;
  } catch {
    return false;
  }
}

async function body(req: IncomingMessage): Promise<Record<string, unknown>> {
  return await new Promise((resolve, reject) => {
    let raw = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => {
      raw += chunk;
      if (raw.length > 1_000_000) {
        reject(new Error("Request body too large"));
        req.destroy();
      }
    });
    req.on("end", () => {
      try { resolve(raw ? JSON.parse(raw) : {}); }
      catch { reject(new Error("Invalid JSON")); }
    });
    req.on("error", reject);
  });
}

function snapshot(): unknown {
  const ctx = state.ctx;
  if (!ctx) return { connected: false, busy: state.busy, messages: [] };
  const entries = ctx.sessionManager.getBranch();
  return {
    connected: true,
    busy: state.busy,
    cwd: ctx.cwd,
    sessionId: ctx.sessionManager.getSessionId(),
    sessionName: state.api?.getSessionName(),
    model: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "No model",
    messages: entries
      .filter((entry) => entry.type === "message")
      .map((entry) => ({ id: entry.id, message: entry.message })),
  };
}

function broadcast(type: string, data: unknown): void {
  const packet = `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const client of [...state.clients]) {
    try { client.write(packet); }
    catch { state.clients.delete(client); }
  }
}

function sync(): void {
  broadcast(EVENT_SYNC, snapshot());
}

function completionChunk(completion: Completion, delta: string, finishReason: string | null = null): string {
  return JSON.stringify({
    id: completion.id,
    object: "chat.completion.chunk",
    created: completion.created,
    model: "pi-session",
    choices: [{ index: 0, delta: delta ? { content: delta } : {}, finish_reason: finishReason }],
  });
}

function pushCompletionDelta(delta: string): void {
  for (const completion of state.completions) {
    completion.text += delta;
    if (completion.stream) completion.response.write(`data: ${completionChunk(completion, delta)}\n\n`);
  }
}

function settleCompletions(): void {
  for (const completion of [...state.completions]) {
    if (completion.heartbeat) clearInterval(completion.heartbeat);
    if (completion.stream) {
      completion.response.write(`data: ${completionChunk(completion, "", "stop")}\n\n`);
      completion.response.end("data: [DONE]\n\n");
    } else {
      json(completion.response, 200, {
        id: completion.id,
        object: "chat.completion",
        created: completion.created,
        model: "pi-session",
        choices: [{ index: 0, message: { role: "assistant", content: completion.text }, finish_reason: "stop" }],
      });
    }
    state.completions.delete(completion);
  }
}

function messageText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((part) => {
    if (!part || typeof part !== "object") return "";
    const value = part as { type?: string; text?: string };
    return value.type === "text" && typeof value.text === "string" ? value.text : "";
  }).filter(Boolean).join("\n");
}

const PAGE = String.raw`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>Pi Remote Control</title><style>
:root{color-scheme:dark;--bg:#0b0d10;--panel:#15191f;--line:#29313b;--text:#e8edf2;--muted:#8d99a6;--accent:#ff7a45;--user:#24344a;--error:#ff6b6b}*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:15px/1.45 ui-sans-serif,system-ui,-apple-system,sans-serif}.app{height:100dvh;display:flex;flex-direction:column;max-width:900px;margin:auto}.top{padding:10px 14px;border-bottom:1px solid var(--line);background:rgba(11,13,16,.94);display:flex;gap:10px;align-items:center}.dot{width:9px;height:9px;border-radius:50%;background:#777}.dot.on{background:#48d597;box-shadow:0 0 10px #48d597}.title{font-weight:700}.meta{color:var(--muted);font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.grow{flex:1}.abort{border:1px solid #6b3434;background:#2b1717;color:#ffaaaa;border-radius:8px;padding:7px 10px}.messages{flex:1;overflow:auto;padding:18px 12px 120px}.msg{max-width:92%;margin:0 0 14px;padding:10px 12px;border:1px solid var(--line);border-radius:12px;background:var(--panel);white-space:pre-wrap;overflow-wrap:anywhere}.msg.user{margin-left:auto;background:var(--user)}.msg.tool{font:12px/1.4 ui-monospace,SFMono-Regular,monospace;color:#b9c4cf;max-height:240px;overflow:auto}.role{font-size:11px;text-transform:uppercase;letter-spacing:.08em;color:var(--muted);margin-bottom:5px}.composer{position:fixed;bottom:0;left:0;right:0;max-width:900px;margin:auto;padding:10px 12px max(10px,env(safe-area-inset-bottom));background:linear-gradient(transparent,var(--bg) 18%);display:flex;gap:8px;align-items:flex-end}.box{flex:1;background:var(--panel);border:1px solid var(--line);border-radius:13px;padding:10px 12px;color:var(--text);font:inherit;resize:none;max-height:160px;min-height:44px}.send{height:44px;border:0;border-radius:11px;background:var(--accent);color:#160b06;font-weight:800;padding:0 16px}.send:disabled{opacity:.5}.banner{display:none;padding:10px 14px;background:#311b1b;color:#ffb6b6;text-align:center}.thinking{color:var(--muted);font-style:italic}.toolname{color:#ffc09f}.empty{text-align:center;color:var(--muted);margin-top:25vh}</style></head>
<body><div class="app"><div id="banner" class="banner"></div><header class="top"><span id="dot" class="dot"></span><div class="grow"><div class="title">π Remote Control</div><div id="meta" class="meta">Pairing…</div></div><button id="abort" class="abort">Stop</button></header><main id="messages" class="messages"><div class="empty">Connecting to Pi…</div></main><form id="form" class="composer"><textarea id="box" class="box" rows="1" placeholder="Message Pi…"></textarea><button id="send" class="send">Send</button></form></div>
<script>
const $=id=>document.getElementById(id), messages=$('messages'), box=$('box'), send=$('send');let current=null, live=null, first=true;
function text(content){if(typeof content==='string')return content;if(!Array.isArray(content))return '';return content.map(x=>x.type==='text'?x.text:x.type==='thinking'?'Thinking…':x.type==='toolCall'?'→ '+x.name+' '+JSON.stringify(x.arguments??{}):x.type==='image'?'[image]':'').filter(Boolean).join('\n')}
function render(s){current=s;$('dot').className='dot'+(s.connected?' on':'');$('meta').textContent=(s.sessionName?s.sessionName+' · ':'')+(s.model||'')+(s.busy?' · working':' · ready');messages.innerHTML='';for(const item of s.messages||[]){const m=item.message||{},d=document.createElement('div');d.className='msg '+(m.role==='user'?'user':m.role==='toolResult'?'tool':'assistant');const role=document.createElement('div');role.className='role';role.textContent=m.role==='toolResult'?(m.toolName||'tool'):m.role;const content=document.createElement('div');content.textContent=text(m.content);d.append(role,content);messages.append(d)}if(!(s.messages||[]).length)messages.innerHTML='<div class="empty">This session has no messages yet.</div>';live=null;if(first||s.busy){messages.scrollTop=messages.scrollHeight;first=false}}
function streamDelta(delta){if(!live){live=document.createElement('div');live.className='msg assistant';live.innerHTML='<div class="role">assistant</div><div class="stream"></div>';messages.append(live)}live.querySelector('.stream').textContent+=delta;messages.scrollTop=messages.scrollHeight}
function parseSSE(reader){const dec=new TextDecoder();let buf='';return(async()=>{for(;;){const {done,value}=await reader.read();if(done)throw Error('Disconnected');buf+=dec.decode(value,{stream:true});let i;while((i=buf.indexOf('\n\n'))>=0){const chunk=buf.slice(0,i);buf=buf.slice(i+2);let event='message',data='';for(const line of chunk.split('\n')){if(line.startsWith('event: '))event=line.slice(7);if(line.startsWith('data: '))data+=line.slice(6)}if(!data)continue;const value=JSON.parse(data);if(event==='sync')render(value);else if(event==='delta')streamDelta(value.delta||'')}}})()}
async function api(path,opts={}){const r=await fetch(path,{...opts,headers:{'content-type':'application/json',...(opts.headers||{})}});if(!r.ok)throw Error((await r.json().catch(()=>({}))).error||r.statusText);return r}
async function boot(){try{const token=location.hash.slice(1);if(token){await api('/api/pair',{method:'POST',headers:{authorization:'Bearer '+token}});history.replaceState(null,'',location.pathname)}const initial=await fetch('/api/state');if(!initial.ok)throw Error('Pairing required. Open the complete link shown by Pi.');render(await initial.json());const r=await fetch('/api/events');if(!r.ok)throw Error('Live connection failed.');parseSSE(r.body.getReader()).catch(reconnect)}catch(e){fail(e.message)}}
function reconnect(e){fail(e.message+' — reconnecting…');setTimeout(()=>location.reload(),2000)}function fail(msg){$('banner').style.display='block';$('banner').textContent=msg;$('dot').className='dot'}
$('form').onsubmit=async e=>{e.preventDefault();const message=box.value.trim();if(!message)return;send.disabled=true;try{await api('/api/prompt',{method:'POST',body:JSON.stringify({message,mode:'steer'})});box.value=''}catch(e){fail(e.message)}finally{send.disabled=false;box.focus()}};
box.onkeydown=e=>{if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();$('form').requestSubmit()}};box.oninput=()=>{box.style.height='auto';box.style.height=Math.min(box.scrollHeight,160)+'px'};
$('abort').onclick=()=>api('/api/abort',{method:'POST',body:'{}'}).catch(e=>fail(e.message));boot();
</script></body></html>`;

function handle(req: IncomingMessage, res: ServerResponse): void {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  const secureHeaders = {
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
    "content-security-policy": "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'",
  };
  for (const [key, value] of Object.entries(secureHeaders)) res.setHeader(key, value);

  if (req.method === "GET" && url.pathname === "/") {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(PAGE);
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/pair") {
    const supplied = req.headers.authorization?.replace(/^Bearer\s+/i, "") ?? "";
    if (!validToken(supplied)) return json(res, 401, { error: "Invalid pairing token" });
    const secure = req.headers["x-forwarded-proto"] === "https";
    res.setHeader("set-cookie", `pi_remote=${encodeURIComponent(state.token)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=86400${secure ? "; Secure" : ""}`);
    return json(res, 200, { ok: true });
  }

  if (url.pathname.startsWith("/v1/")) {
    res.setHeader("access-control-allow-origin", "*");
    res.setHeader("access-control-allow-headers", "authorization, content-type");
    res.setHeader("access-control-allow-methods", "GET, POST, OPTIONS");
    if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }
    if (!apiAuthorized(req)) return json(res, 401, { error: { message: "Invalid API key", type: "authentication_error" } });

    if (req.method === "GET" && url.pathname === "/v1/models") {
      return json(res, 200, { object: "list", data: [{ id: "pi-session", object: "model", created: 0, owned_by: "pi" }] });
    }

    if (req.method === "POST" && url.pathname === "/v1/chat/completions") {
      void body(req).then((value) => {
        if (!state.api || !state.ctx) return json(res, 503, { error: { message: "Pi session is unavailable" } });
        if (!state.ctx.isIdle() || state.completions.size > 0) return json(res, 409, { error: { message: "Pi is already working" } });
        const messages = Array.isArray(value.messages) ? value.messages : [];
        const lastUser = [...messages].reverse().find((message) => message && typeof message === "object" && (message as { role?: string }).role === "user") as { content?: unknown } | undefined;
        const prompt = messageText(lastUser?.content).trim();
        if (!prompt) return json(res, 400, { error: { message: "A user message is required" } });

        const completion: Completion = {
          id: `chatcmpl-${randomBytes(12).toString("hex")}`,
          response: res,
          stream: value.stream === true,
          created: Math.floor(Date.now() / 1000),
          text: "",
        };
        state.completions.add(completion);
        if (completion.stream) {
          res.writeHead(200, {
            "content-type": "text/event-stream; charset=utf-8",
            "cache-control": "no-cache, no-transform",
            connection: "keep-alive",
            "x-accel-buffering": "no",
          });
          res.flushHeaders();
          res.write(`data: ${completionChunk(completion, "")}\n\n`);
          completion.heartbeat = setInterval(() => res.write(": ping\n\n"), 15_000);
        }
        res.on("close", () => {
          if (completion.heartbeat) clearInterval(completion.heartbeat);
          if (!res.writableEnded) state.completions.delete(completion);
        });
        try { state.api.sendUserMessage(prompt); }
        catch (error) {
          state.completions.delete(completion);
          if (completion.heartbeat) clearInterval(completion.heartbeat);
          if (!res.headersSent) json(res, 500, { error: { message: error instanceof Error ? error.message : String(error) } });
          else res.end(`data: ${JSON.stringify({ error: { message: String(error) } })}\n\ndata: [DONE]\n\n`);
        }
      }).catch((error) => json(res, 400, { error: { message: error.message } }));
      return;
    }

    return json(res, 404, { error: { message: "Not found" } });
  }

  if (!authorized(req)) return json(res, 401, { error: "Not paired" });
  if (!sameOrigin(req)) return json(res, 403, { error: "Origin rejected" });

  if (req.method === "GET" && url.pathname === "/api/state") {
    return json(res, 200, snapshot());
  }

  if (req.method === "GET" && url.pathname === "/api/events") {
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache, no-transform", connection: "keep-alive", "x-accel-buffering": "no" });
    res.flushHeaders();
    res.write(`event: sync\ndata: ${JSON.stringify(snapshot())}\n\n`);
    state.clients.add(res);
    const heartbeat = setInterval(() => res.write(": ping\n\n"), 15_000);
    req.on("close", () => { clearInterval(heartbeat); state.clients.delete(res); });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/prompt") {
    void body(req).then((value) => {
      const message = typeof value.message === "string" ? value.message.trim() : "";
      if (!message) return json(res, 400, { error: "Message is required" });
      if (!state.api || !state.ctx) return json(res, 503, { error: "Pi session is unavailable" });
      try {
        if (state.ctx.isIdle()) state.api.sendUserMessage(message);
        else state.api.sendUserMessage(message, { deliverAs: value.mode === "followUp" ? "followUp" : "steer" });
        json(res, 202, { ok: true });
      } catch (error) { json(res, 500, { error: error instanceof Error ? error.message : String(error) }); }
    }).catch((error) => json(res, 400, { error: error.message }));
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/abort") {
    state.ctx?.abort();
    return json(res, 202, { ok: true });
  }

  json(res, 404, { error: "Not found" });
}

async function startServer(): Promise<number> {
  if (state.server && state.port) return state.port;
  state.token = randomBytes(32).toString("base64url");
  const server = createServer(handle);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Could not determine remote-control port");
  state.server = server;
  state.port = address.port;
  return address.port;
}

async function startTunnel(port: number): Promise<string> {
  if (state.tunnel && state.publicUrl) return state.publicUrl;
  const child = spawn("cloudflared", ["tunnel", "--url", `http://127.0.0.1:${port}`, "--no-autoupdate"], { stdio: ["ignore", "pipe", "pipe"] });
  state.tunnel = child;
  return await new Promise<string>((resolve, reject) => {
    let output = "";
    const timer = setTimeout(() => reject(new Error("Timed out waiting for the Cloudflare tunnel")), 20_000);
    const inspect = (chunk: Buffer) => {
      output += chunk.toString();
      const match = output.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/i);
      if (match) {
        clearTimeout(timer);
        state.publicUrl = match[0];
        resolve(match[0]);
      }
    };
    child.stdout.on("data", inspect);
    child.stderr.on("data", inspect);
    child.once("error", (error) => { clearTimeout(timer); reject(error); });
    child.once("exit", (code) => {
      state.tunnel = undefined;
      state.publicUrl = undefined;
      if (!state.server) return;
      broadcast("offline", { code });
    });
  });
}

function stop(): void {
  state.tunnel?.kill("SIGTERM");
  state.tunnel = undefined;
  state.publicUrl = undefined;
  for (const client of state.clients) client.end();
  state.clients.clear();
  for (const completion of state.completions) {
    if (completion.heartbeat) clearInterval(completion.heartbeat);
    completion.response.end();
  }
  state.completions.clear();
  state.server?.close();
  state.server = undefined;
  state.port = undefined;
}

function pairingUrl(base: string): string {
  return `${base}/#${state.token}`;
}

export default function remoteControl(pi: ExtensionAPI) {
  state.api = pi;

  pi.on(PI_EVENT.SESSION_START, async (_event, ctx) => {
    state.ctx = ctx;
    state.busy = false;
    sync();
  });
  pi.on(PI_EVENT.AGENT_START, async () => { state.busy = true; sync(); });
  pi.on(PI_EVENT.AGENT_SETTLED, async () => { state.busy = false; settleCompletions(); sync(); });
  pi.on(PI_EVENT.MESSAGE_UPDATE, async (event) => {
    const update = event.assistantMessageEvent;
    if (update.type === UPDATE_TEXT_DELTA) {
      broadcast(EVENT_DELTA, { delta: update.delta });
      pushCompletionDelta(update.delta);
    }
  });
  pi.on(PI_EVENT.MESSAGE_END, async () => sync());
  pi.on(PI_EVENT.TOOL_EXECUTION_START, async (event) => broadcast(EVENT_TOOL, { phase: PHASE_START, name: event.toolName }));
  pi.on(PI_EVENT.TOOL_EXECUTION_END, async (event) => { broadcast(EVENT_TOOL, { phase: PHASE_END, name: event.toolName, error: event.isError }); sync(); });
  pi.on(PI_EVENT.SESSION_SHUTDOWN, async (event) => {
    state.ctx = undefined;
    state.busy = false;
    if (event.reason === QUIT) stop();
    else sync();
  });

  pi.registerCommand(COMMAND_NAME, {
    description: COMMAND_DESCRIPTION,
    handler: async (args, ctx) => {
      const action = args.trim().toLowerCase() || ACTION_START;
      if (action === ACTION_STOP) {
        stop();
        ctx.ui.setStatus(STATUS_KEY, undefined);
        ctx.ui.setWidget(STATUS_KEY, undefined);
        ctx.ui.notify(NOTE_STOPPED, NOTE_INFO);
        return;
      }
      if (action === ACTION_STATUS) {
        if (!state.server || !state.port) ctx.ui.notify(NOTE_NOT_RUNNING, NOTE_INFO);
        else ctx.ui.notify(`Remote control: ${state.publicUrl ?? `http://127.0.0.1:${state.port}`}`, NOTE_INFO);
        return;
      }
      if (action !== ACTION_START && action !== ACTION_LOCAL) {
        ctx.ui.notify(NOTE_USAGE, NOTE_WARNING);
        return;
      }

      try {
        const port = await startServer();
        let base = `http://127.0.0.1:${port}`;
        if (action === ACTION_START) base = await startTunnel(port);
        const url = pairingUrl(base);
        ctx.ui.setStatus(STATUS_KEY, STATUS_ENABLED);
        ctx.ui.setWidget(STATUS_KEY, [
          "Pi remote control is active",
          url,
          `OpenAI clients: base ${base}/v1 · model ${MODEL_NAME} · API key ${state.token}`,
          `Anyone with this link or API key can control Pi and its tools. Use /${COMMAND_NAME} ${ACTION_STOP} when done.`,
        ], { placement: WIDGET_PLACEMENT });
        if (process.platform === PLATFORM_MACOS) {
          const clipboard = spawn(CLIPBOARD_COMMAND);
          clipboard.stdin.end(url);
        }
        ctx.ui.notify(action === ACTION_START ? "Secure tunnel ready; pairing URL shown above and copied" : "Local remote ready; pairing URL shown above and copied", NOTE_INFO);
      } catch (error) {
        stop();
        ctx.ui.notify(`Remote control failed: ${error instanceof Error ? error.message : String(error)}`, NOTE_ERROR);
      }
    },
  });
}
