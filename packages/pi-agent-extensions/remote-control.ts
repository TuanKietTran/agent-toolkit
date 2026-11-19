import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { spawn, type ChildProcessByStdio } from "node:child_process";
import type { Readable } from "node:stream";
import { parseResumePoint, sanitizeContent, sseFrame, type AgentEvent } from "./runtime/events.ts";
import { getRuntime, type AgentRuntime, type ControlResult } from "./runtime/runtime.ts";
import { PI_EVENT } from "./core/events.ts";

// --- Constants: every local literal lives here. ---

const STATE_KEY = Symbol.for("pi.remote-control.state.v1");
const COMMAND_NAME = "remote-control";
const COMMAND_DESCRIPTION = "Start, stop, or show the secure browser remote for this Pi session";
const EXECUTION_COMMAND = "execution";
const EXECUTION_DESCRIPTION = "Inspect or control the running agent execution: status | pause | resume | cancel";
const STATUS_KEY = "remote-control";
const ACTION_START = "start";
const ACTION_STOP = "stop";
const ACTION_STATUS = "status";
const ACTION_LOCAL = "local";
const QUIT = "quit";
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
const EXECUTION_USAGE = "Usage: /execution [status|pause|resume|cancel]";
const HEARTBEAT_MS = 15_000;
/** A client whose socket buffer grows past this is disconnected; it reconnects and replays from its Last-Event-ID. */
const SLOW_CLIENT_BYTES = 4 * 1024 * 1024;

type Client = { res: ServerResponse; unsubscribe: () => void; heartbeat: ReturnType<typeof setInterval> };
type Completion = {
  id: string;
  response: ServerResponse;
  stream: boolean;
  created: number;
  text: string;
  heartbeat?: ReturnType<typeof setInterval>;
};
type RemoteState = {
  server?: Server;
  tunnel?: ChildProcessByStdio<null, Readable, Readable>;
  port?: number;
  publicUrl?: string;
  token: string;
  clients: Set<Client>;
  completions: Set<Completion>;
  completionUnsubscribe?: () => void;
  droppedSlowClients: number;
};

const globals = globalThis as typeof globalThis & { [STATE_KEY]?: RemoteState };
const state: RemoteState = globals[STATE_KEY] ?? {
  token: randomBytes(32).toString("base64url"),
  clients: new Set(),
  completions: new Set(),
  droppedSlowClients: 0,
};
state.completions ??= new Set();
state.droppedSlowClients ??= 0;
globals[STATE_KEY] = state;

function runtime(): AgentRuntime { return getRuntime(); }

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

/** Conversation snapshot for (re)connecting clients. Image data is replaced by size placeholders. */
function snapshot(): unknown {
  const rt = runtime();
  const ctx = rt.context;
  const status = rt.status();
  if (!ctx) return { connected: false, busy: rt.busy, status, messages: [] };
  const entries = ctx.sessionManager.getBranch();
  return {
    connected: true,
    busy: rt.busy,
    status,
    cwd: ctx.cwd,
    sessionId: ctx.sessionManager.getSessionId(),
    sessionName: rt.extensionApi?.getSessionName(),
    model: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "No model",
    messages: entries
      .filter((entry) => entry.type === "message")
      .map((entry) => {
        // Tool details are runtime data for extensions, not for display; content keeps only image placeholders.
        const { details: _details, ...message } = entry.message as unknown as Record<string, unknown>;
        return { id: entry.id, message: { ...message, content: sanitizeContent(message.content) } };
      }),
  };
}

function writeOrDrop(client: Client, chunk: string): void {
  if (client.res.writableEnded || client.res.destroyed) return;
  client.res.write(chunk);
  if (client.res.writableLength > SLOW_CLIENT_BYTES) {
    state.droppedSlowClients++;
    closeClient(client);
  }
}

function closeClient(client: Client): void {
  client.unsubscribe();
  clearInterval(client.heartbeat);
  state.clients.delete(client);
  try { client.res.end(); } catch {}
}

function completionChunk(completion: Completion, delta: string, finishReason: string | null = null): string {
  return JSON.stringify({
    id: completion.id,
    object: "chat.completion.chunk",
    created: completion.created,
    model: MODEL_NAME,
    choices: [{ index: 0, delta: delta ? { content: delta } : {}, finish_reason: finishReason }],
  });
}

function settleCompletions(event?: AgentEvent): void {
  for (const completion of [...state.completions]) {
    if (completion.heartbeat) clearInterval(completion.heartbeat);
    const failed = event?.type === "agent.failed" ? event.error : event?.type === "agent.cancelled" ? "cancelled" : undefined;
    if (completion.stream) {
      if (failed) completion.response.write(`data: ${JSON.stringify({ error: { message: failed } })}\n\n`);
      completion.response.write(`data: ${completionChunk(completion, "", "stop")}\n\n`);
      completion.response.end("data: [DONE]\n\n");
    } else {
      json(completion.response, 200, {
        id: completion.id,
        object: "chat.completion",
        created: completion.created,
        model: MODEL_NAME,
        choices: [{ index: 0, message: { role: "assistant", content: completion.text }, finish_reason: "stop" }],
      });
    }
    state.completions.delete(completion);
  }
}

/** The OpenAI facade reads the same event log as every other client. */
function ensureCompletionFeed(): void {
  if (state.completionUnsubscribe) return;
  state.completionUnsubscribe = runtime().log.subscribe((event) => {
    if (!state.completions.size) return;
    if (event.type === "message.delta") {
      for (const completion of state.completions) {
        completion.text += event.content;
        if (completion.stream) completion.response.write(`data: ${completionChunk(completion, event.content)}\n\n`);
      }
    } else if (event.type === "agent.completed" || event.type === "agent.failed" || event.type === "agent.cancelled") {
      settleCompletions(event);
    }
  });
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
:root{color-scheme:dark;--bg:#0b0d10;--panel:#15191f;--line:#29313b;--text:#e8edf2;--muted:#8d99a6;--accent:#ff7a45;--user:#24344a;--ok:#48d597;--bad:#ff6b6b;--warn:#f5c26b}*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:15px/1.45 ui-sans-serif,system-ui,-apple-system,sans-serif}.app{height:100dvh;display:flex;flex-direction:column;max-width:900px;margin:auto}.top{padding:10px 14px;border-bottom:1px solid var(--line);display:flex;gap:8px;align-items:center}.dot{width:9px;height:9px;border-radius:50%;background:#777;flex:none}.dot.on{background:var(--ok)}.title{font-weight:700}.meta{color:var(--muted);font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.grow{flex:1;min-width:0}.btn{border:1px solid var(--line);background:var(--panel);color:var(--text);border-radius:8px;padding:7px 10px;font:inherit;font-size:13px}.btn.stop{border-color:#6b3434;background:#2b1717;color:#ffaaaa}.messages{flex:1;overflow:auto;padding:18px 12px 120px}.msg{max-width:92%;margin:0 0 12px;padding:10px 12px;border:1px solid var(--line);border-radius:12px;background:var(--panel);white-space:pre-wrap;overflow-wrap:anywhere}.msg.user{margin-left:auto;background:var(--user)}.tool{font:12px/1.4 ui-monospace,SFMono-Regular,monospace;color:#b9c4cf}.tool .head{color:#ffc09f}.tool .line{color:var(--muted)}.tool.ok .head:after{content:" ✓";color:var(--ok)}.tool.fail .head:after{content:" ✗";color:var(--bad)}.tool.warn .head:after{content:" ⚠ not verified";color:var(--warn)}.tool img{max-width:100%;border-radius:6px;margin-top:6px;border:1px solid var(--line)}.role{font-size:11px;text-transform:uppercase;letter-spacing:.08em;color:var(--muted);margin-bottom:5px}.sys{color:var(--muted);font-size:12px;text-align:center;margin:6px 0 12px}.composer{position:fixed;bottom:0;left:0;right:0;max-width:900px;margin:auto;padding:10px 12px max(10px,env(safe-area-inset-bottom));background:linear-gradient(transparent,var(--bg) 18%);display:flex;gap:8px;align-items:flex-end}.box{flex:1;background:var(--panel);border:1px solid var(--line);border-radius:13px;padding:10px 12px;color:var(--text);font:inherit;resize:none;max-height:160px;min-height:44px}.send{height:44px;border:0;border-radius:11px;background:var(--accent);color:#160b06;font-weight:800;padding:0 16px}.banner{display:none;padding:8px 14px;background:#311b1b;color:#ffb6b6;text-align:center;font-size:13px}.empty{text-align:center;color:var(--muted);margin-top:25vh}</style></head>
<body><div class="app"><div id="banner" class="banner"></div><header class="top"><span id="dot" class="dot"></span><div class="grow"><div class="title">π Remote Control</div><div id="meta" class="meta">Pairing…</div></div><button id="pause" class="btn">Pause</button><button id="abort" class="btn stop">Stop</button></header><main id="messages" class="messages"><div class="empty">Connecting to Pi…</div></main><form id="form" class="composer"><textarea id="box" class="box" rows="1" placeholder="Message Pi…"></textarea><button id="send" class="send">Send</button></form></div>
<script>
const $=id=>document.getElementById(id),messages=$('messages'),box=$('box');let lastSeq=0,live=null,model='',runState='idle',tools={},lost=0;
const TYPES=['session.created','agent.started','agent.state','agent.waiting','agent.pause_requested','agent.paused','agent.resumed','agent.instruction','agent.completed','agent.failed','agent.cancelled','activity.updated','message.started','message.delta','message.completed','tool.requested','tool.started','tool.progress','tool.completed','tool.failed','tool.skipped','computer.action','computer.observation','artifact.created'];
function text(content){if(typeof content==='string')return content;if(!Array.isArray(content))return '';return content.map(x=>x.type==='text'?x.text:x.type==='toolCall'?'→ '+x.name+' '+JSON.stringify(x.arguments??{}):x.type==='image'?'[image]':'').filter(Boolean).join('\n')}
function el(cls,role,body){const d=document.createElement('div');d.className=cls;if(role){const r=document.createElement('div');r.className='role';r.textContent=role;d.append(r)}const c=document.createElement('div');c.className='body';c.textContent=body||'';d.append(c);messages.append(d);messages.scrollTop=messages.scrollHeight;return d}
function sys(t){const d=document.createElement('div');d.className='sys';d.textContent=t;messages.append(d);messages.scrollTop=messages.scrollHeight}
function meta(){$('meta').textContent=model+' · '+runState+(lost?' · '+lost+' events lost':'');$('pause').textContent=runState==='paused'?'Resume':'Pause'}
function render(s){messages.innerHTML='';live=null;tools={};model=s.model||'';runState=(s.status&&s.status.state)||'idle';$('dot').className='dot'+(s.connected?' on':'');for(const item of s.messages||[]){const m=item.message||{};el('msg '+(m.role==='user'?'user':m.role==='toolResult'?'tool':'assistant'),m.role==='toolResult'?(m.toolName||'tool'):m.role,text(m.content))}if(!(s.messages||[]).length)messages.innerHTML='<div class="empty">This session has no messages yet.</div>';meta()}
function card(id,name){if(!tools[id]){const d=el('msg tool','',' ');d.querySelector('.body').innerHTML='';const h=document.createElement('div');h.className='head';h.textContent=name;d.querySelector('.body').append(h);tools[id]=d}return tools[id]}
function line(id,name,t){const d=card(id,name),l=document.createElement('div');l.className='line';l.textContent=t;d.querySelector('.body').append(l);messages.scrollTop=messages.scrollHeight}
function handle(e){if(e.seq<=lastSeq)return;if(lastSeq&&e.seq>lastSeq+1){lost+=e.seq-lastSeq-1}lastSeq=e.seq;switch(e.type){
case 'session.created':fetchState();break;
case 'agent.state':runState=e.state;meta();break;
case 'message.started':live=el('msg assistant','assistant','');break;
case 'message.delta':if(!live)live=el('msg assistant','assistant','');live.querySelector('.body').textContent+=e.content;messages.scrollTop=messages.scrollHeight;break;
case 'message.completed':if(e.role==='user'){el('msg user','user',e.text||'')}else{if(!live&&e.text)live=el('msg assistant','assistant',e.text);else if(live&&e.text)live.querySelector('.body').textContent=e.text;if(e.error)sys('model error: '+e.error);live=null}break;
case 'tool.started':line(e.toolCallId,e.toolName,JSON.stringify(e.args||{}).slice(0,300));break;
case 'tool.progress':line(e.toolCallId,e.toolName,'… '+(e.message||''));break;
case 'computer.action':line(e.toolCallId,'computer',e.action+' '+e.status+(e.target?' '+e.target:'')+(e.detail?' — '+e.detail:''));break;
case 'computer.observation':line(e.toolCallId,'computer',(e.verified===true?'verified: ':e.verified===false?'NOT verified: ':'observed: ')+(e.evidence||'')+(e.url?' @ '+e.url:''));break;
case 'artifact.created':{const d=card(e.toolCallId||e.artifactId,'artifact'),img=document.createElement('img');img.src='/api/artifacts/'+e.artifactId;img.alt=e.kind;d.querySelector('.body').append(img);break}
case 'tool.completed':{const d=card(e.toolCallId,e.toolName);d.classList.add(e.verified===false?'warn':'ok');line(e.toolCallId,e.toolName,(e.summary||'done').slice(0,300)+' ('+e.durationMs+'ms)');break}
case 'tool.failed':{const d=card(e.toolCallId,e.toolName);d.classList.add('fail');line(e.toolCallId,e.toolName,e.error.slice(0,300));break}
case 'tool.skipped':{const d=card(e.toolCallId,e.toolName);d.classList.add('fail');line(e.toolCallId,e.toolName,'not run: '+e.reason);break}
case 'agent.paused':sys('paused before '+(e.at==='tool_call'?(e.toolName||'tool'):'next model request'));break;
case 'agent.resumed':sys('resumed');break;case 'agent.pause_requested':sys('pause requested');break;
case 'agent.completed':sys('completed');break;case 'agent.failed':sys('failed: '+e.error);break;case 'agent.cancelled':sys('cancelled');break;}}
async function api(path,opts={}){const r=await fetch(path,{...opts,headers:{'content-type':'application/json',...(opts.headers||{})}});if(!r.ok)throw Error((await r.json().catch(()=>({}))).error||r.statusText);return r}
async function fetchState(){const r=await fetch('/api/state');if(!r.ok)throw Error('Pairing required. Open the complete link shown by Pi.');const s=await r.json();render(s);lastSeq=s.status?s.status.lastSeq:0}
function listen(){const es=new EventSource('/api/events?since='+lastSeq);for(const t of TYPES)es.addEventListener(t,ev=>handle(JSON.parse(ev.data)));es.addEventListener('reset',()=>{lost=0;fetchState()});es.onopen=()=>{$('banner').style.display='none';$('dot').className='dot on'};es.onerror=()=>{$('dot').className='dot';fail('Live connection interrupted — reconnecting…')}}
async function boot(){try{const token=location.hash.slice(1);if(token){await api('/api/pair',{method:'POST',headers:{authorization:'Bearer '+token}});history.replaceState(null,'',location.pathname)}await fetchState();listen()}catch(e){fail(e.message)}}
function fail(msg){$('banner').style.display='block';$('banner').textContent=msg}
$('form').onsubmit=async e=>{e.preventDefault();const message=box.value.trim();if(!message)return;try{await api('/api/prompt',{method:'POST',body:JSON.stringify({message,mode:'steer'})});box.value=''}catch(e){fail(e.message)}};
box.onkeydown=e=>{if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();$('form').requestSubmit()}};box.oninput=()=>{box.style.height='auto';box.style.height=Math.min(box.scrollHeight,160)+'px'};
$('pause').onclick=()=>api(runState==='paused'||$('pause').textContent==='Resume'?'/api/resume':'/api/pause',{method:'POST',body:'{}'}).then(()=>{$('pause').textContent=$('pause').textContent==='Pause'?'Resume':'Pause'}).catch(e=>fail(e.message));
$('abort').onclick=()=>api('/api/cancel',{method:'POST',body:'{}'}).catch(e=>fail(e.message));boot();
</script></body></html>`;

function openEventStream(req: IncomingMessage, res: ServerResponse, url: URL): void {
  const rt = runtime();
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache, no-transform", connection: "keep-alive", "x-accel-buffering": "no" });
  res.flushHeaders();
  res.write("retry: 2000\n\n");
  const resumeFrom = parseResumePoint((req.headers["last-event-id"] as string | undefined) ?? url.searchParams.get("since"), rt.log.logId);
  // Subscribe before replaying so nothing produced in between is missed; replayed events are de-duplicated by seq.
  const queued: AgentEvent[] = [];
  let replaying = true;
  let lastSent = resumeFrom ?? rt.log.lastSeq;
  const client: Client = {
    res,
    unsubscribe: () => undefined,
    heartbeat: setInterval(() => { if (!res.writableEnded) res.write(": ping\n\n"); }, HEARTBEAT_MS),
  };
  const send = (event: AgentEvent) => {
    if (event.seq <= lastSent) return;
    lastSent = event.seq;
    writeOrDrop(client, sseFrame(event));
  };
  client.unsubscribe = rt.log.subscribe((event) => { if (replaying) queued.push(event); else send(event); });
  state.clients.add(client);
  if (resumeFrom !== undefined) {
    const replay = rt.log.since(resumeFrom);
    if (replay.truncated) {
      // The client fell further behind than the retained window: tell it to resync from a snapshot.
      res.write(`event: reset\ndata: ${JSON.stringify({ reason: "replay window exceeded", oldestSeq: rt.log.oldestSeq, lastSeq: rt.log.lastSeq })}\n\n`);
      lastSent = rt.log.lastSeq;
    } else {
      for (const event of replay.events) send(event);
    }
  }
  replaying = false;
  for (const event of queued.splice(0)) send(event);
  req.on("close", () => closeClient(client));
}

function control(res: ServerResponse, result: ControlResult): void {
  json(res, result.ok ? 202 : 409, result);
}

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
      return json(res, 200, { object: "list", data: [{ id: MODEL_NAME, object: "model", created: 0, owned_by: "pi" }] });
    }

    if (req.method === "POST" && url.pathname === "/v1/chat/completions") {
      void body(req).then((value) => {
        const rt = runtime();
        const api = rt.extensionApi, ctx = rt.context;
        if (!api || !ctx) return json(res, 503, { error: { message: "Pi session is unavailable" } });
        if (!ctx.isIdle() || rt.busy || state.completions.size > 0) return json(res, 409, { error: { message: "Pi is already working" } });
        const messages = Array.isArray(value.messages) ? value.messages : [];
        const lastUser = [...messages].reverse().find((message) => message && typeof message === "object" && (message as { role?: string }).role === "user") as { content?: unknown } | undefined;
        const prompt = messageText(lastUser?.content).trim();
        if (!prompt) return json(res, 400, { error: { message: "A user message is required" } });

        ensureCompletionFeed();
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
          completion.heartbeat = setInterval(() => res.write(": ping\n\n"), HEARTBEAT_MS);
        }
        // A disconnecting client only stops receiving; the execution it started keeps running.
        res.on("close", () => {
          if (completion.heartbeat) clearInterval(completion.heartbeat);
          if (!res.writableEnded) state.completions.delete(completion);
        });
        try { api.sendUserMessage(prompt); }
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

  if (req.method === "GET" && url.pathname === "/api/state") return json(res, 200, snapshot());
  if (req.method === "GET" && url.pathname === "/api/status") return json(res, 200, { ...runtime().status(), clients: state.clients.size, droppedSlowClients: state.droppedSlowClients });
  if (req.method === "GET" && url.pathname === "/api/events") return openEventStream(req, res, url);

  if (req.method === "GET" && url.pathname.startsWith("/api/artifacts/")) {
    const artifact = runtime().artifact(decodeURIComponent(url.pathname.slice("/api/artifacts/".length)));
    if (!artifact) return json(res, 404, { error: "No such artifact" });
    res.writeHead(200, { "content-type": artifact.mimeType, "cache-control": "private, max-age=3600" });
    res.end(Buffer.from(artifact.data, "base64"));
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/prompt") {
    void body(req).then((value) => {
      const message = typeof value.message === "string" ? value.message.trim() : "";
      if (!message) return json(res, 400, { error: "Message is required" });
      try {
        const result = runtime().instruct(message, value.mode === "followUp" ? "followUp" : "steer");
        json(res, result.ok ? 202 : 503, result);
      } catch (error) { json(res, 500, { error: error instanceof Error ? error.message : String(error) }); }
    }).catch((error) => json(res, 400, { error: error.message }));
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/pause") return control(res, runtime().pause());
  if (req.method === "POST" && url.pathname === "/api/resume") return control(res, runtime().resume());
  if (req.method === "POST" && (url.pathname === "/api/cancel" || url.pathname === "/api/abort")) return control(res, runtime().cancel());

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
    child.once("exit", () => {
      state.tunnel = undefined;
      state.publicUrl = undefined;
    });
  });
}

function stop(): void {
  state.tunnel?.kill("SIGTERM");
  state.tunnel = undefined;
  state.publicUrl = undefined;
  for (const client of [...state.clients]) closeClient(client);
  for (const completion of state.completions) {
    if (completion.heartbeat) clearInterval(completion.heartbeat);
    completion.response.end();
  }
  state.completions.clear();
  state.completionUnsubscribe?.();
  state.completionUnsubscribe = undefined;
  state.server?.close();
  state.server = undefined;
  state.port = undefined;
}

function pairingUrl(base: string): string {
  return `${base}/#${state.token}`;
}

function describeStatus(): string {
  const s = runtime().status();
  const m = s.metrics;
  const tools = s.activeTools.map((t) => `${t.toolName} ${Math.round(t.runningMs / 100) / 10}s`).join(", ");
  return `execution: ${s.state}${s.executionId ? ` (${s.executionId})` : ""}${s.pauseRequested ? ", pause requested" : ""}${tools ? `; running: ${tools}` : ""}` +
    (m ? `; tools=${m.toolCalls} failed=${m.toolFailures} verified=${m.verifiedActions} unverified=${m.unverifiedActions}${m.outcome ? ` last=${m.outcome}` : ""}` : "");
}

export default function remoteControl(pi: ExtensionAPI) {
  const rt = runtime();
  rt.attach(pi);

  pi.on(PI_EVENT.SESSION_SHUTDOWN, async (event) => {
    if (event.reason === QUIT) stop();
  });

  pi.registerCommand(EXECUTION_COMMAND, {
    description: EXECUTION_DESCRIPTION,
    handler: async (args, ctx) => {
      const action = args.trim().toLowerCase() || ACTION_STATUS;
      let result: ControlResult | undefined;
      if (action === "pause") result = rt.pause();
      else if (action === "resume") result = rt.resume();
      else if (action === "cancel") result = rt.cancel();
      else if (action !== ACTION_STATUS) { ctx.ui.notify(EXECUTION_USAGE, NOTE_WARNING); return; }
      if (result && !result.ok) ctx.ui.notify(`execution ${action}: ${result.error}`, NOTE_WARNING);
      else ctx.ui.notify(describeStatus(), NOTE_INFO);
    },
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
        else ctx.ui.notify(`Remote control: ${state.publicUrl ?? `http://127.0.0.1:${state.port}`} · clients ${state.clients.size} · ${describeStatus()}`, NOTE_INFO);
        return;
      }
      if (action !== ACTION_START && action !== ACTION_LOCAL) {
        ctx.ui.notify(NOTE_USAGE, NOTE_WARNING);
        return;
      }

      try {
        const port = await startServer();
        ensureCompletionFeed();
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
        if (process.platform === PLATFORM_MACOS && process.env.PI_REMOTE_CONTROL_NO_CLIPBOARD !== "1") {
          const clipboard = spawn(CLIPBOARD_COMMAND);
          clipboard.on("error", () => undefined);
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
