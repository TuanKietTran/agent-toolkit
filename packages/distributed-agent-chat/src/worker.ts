import { html } from './ui';
import { active, validId, validMode, validSessionId, type Agent, type Run } from './protocol';
import { agentTokens, type TokenEnv } from './auth';

interface Env extends TokenEnv { ROOMS: DurableObjectNamespace }
const json = (data: unknown, status = 200) => Response.json(data, { status, headers: { 'Cache-Control': 'no-store' } });
class HttpError extends Error { constructor(public status: number, message: string) { super(message); } }
function demand(ok: unknown, status: number, message: string): asserts ok { if (!ok) throw new HttpError(status, message); }
function route(request: Request, env: Env) {
  const path = new URL(request.url).pathname;
  const m = /^\/api\/rooms\/([a-zA-Z0-9_-]{1,64})\/(history|events|agents|send|cancel|agent\/([a-zA-Z0-9_-]{1,64})\/(claim|heartbeat|update))$/.exec(path);
  demand(m, 404, 'Not found');
  const agent = m[3] as Agent | undefined;
  const tokens = agent ? agentTokens(env) : undefined;
  const token = agent ? (tokens && Object.hasOwn(tokens, agent) ? tokens[agent] : undefined) : env.CHAT_TOKEN;
  demand(token && request.headers.get('Authorization') === `Bearer ${token}`, 401, 'Unauthorized');
  return { room: m[1], op: agent ? m[4] : m[2], agent };
}
async function body(request: Request) {
  const text = await request.text();
  demand(text.length <= 20000, 413, 'Body too large');
  try { const b = JSON.parse(text); demand(b && typeof b === 'object' && !Array.isArray(b), 400, 'Invalid body'); return b; }
  catch { throw new HttpError(400, 'Invalid JSON body'); }
}
function errorResponse(e: unknown) { return json({ error: e instanceof HttpError ? e.message : 'Internal error' }, e instanceof HttpError ? e.status : 500); }
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      if (new URL(request.url).pathname === '/' && request.method === 'GET') return new Response(html, { headers: {
        'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store',
        'Content-Security-Policy': "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'",
        'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer'
      } });
      const { room } = route(request, env);
      return await env.ROOMS.get(env.ROOMS.idFromName(room)).fetch(request);
    } catch (e) { return errorResponse(e); }
  }
};

export class Room {
  private sql: SqlStorage;
  constructor(private ctx: DurableObjectState, private env: Env) {
    this.sql = ctx.storage.sql;
    this.sql.exec(`CREATE TABLE IF NOT EXISTS runs (
      id TEXT PRIMARY KEY, agent TEXT NOT NULL, prompt TEXT NOT NULL, text TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL, mode TEXT NOT NULL DEFAULT '', error TEXT NOT NULL DEFAULT '',
      session_id TEXT NOT NULL DEFAULT '', worker_id TEXT NOT NULL DEFAULT '',
      lease INTEGER NOT NULL DEFAULT 0, seq INTEGER NOT NULL DEFAULT 0, created INTEGER NOT NULL)`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS sessions (agent TEXT PRIMARY KEY, session_id TEXT NOT NULL,
      worker_id TEXT NOT NULL, mode TEXT NOT NULL, initialized INTEGER NOT NULL DEFAULT 0)`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS events (cursor INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id TEXT NOT NULL, kind TEXT NOT NULL, data TEXT NOT NULL)`);
    this.sql.exec('CREATE INDEX IF NOT EXISTS runs_agent_status ON runs(agent,status)');
    // Additive migration: old room/session data remains valid.
    if (!this.rows<any>('PRAGMA table_info(sessions)').some(c => c.name === 'provider_session_id')) this.sql.exec("ALTER TABLE sessions ADD COLUMN provider_session_id TEXT NOT NULL DEFAULT ''");
    this.sql.exec(`CREATE TABLE IF NOT EXISTS workers (agent TEXT PRIMARY KEY, worker TEXT NOT NULL,
      mode TEXT NOT NULL, seen INTEGER NOT NULL)`);
  }
  private rows<T extends Record<string, SqlStorageValue>>(query: string, ...args: SqlStorageValue[]) { return this.sql.exec<T>(query, ...args).toArray(); }
  private get(id: string): Run | undefined { return this.rows<any>('SELECT * FROM runs WHERE id=?', id)[0]; }
  private event(id: string, kind: string, data: unknown) { this.sql.exec('INSERT INTO events(run_id,kind,data) VALUES(?,?,?)', id, kind, JSON.stringify(data)); }
  private expire() {
    for (const r of this.rows<any>("SELECT * FROM runs WHERE status='running' AND lease < ?", Date.now())) {
      this.sql.exec("UPDATE runs SET status='error', error='Worker lease expired; not retried automatically' WHERE id=?", r.id);
      this.event(r.id, 'state', this.get(r.id));
    }
  }
  async fetch(request: Request): Promise<Response> {
    try {
      const { op, agent } = route(request, this.env);
      demand(request.method === (op === 'history' || op === 'events' || op === 'agents' ? 'GET' : 'POST'), 405, 'Method not allowed');
      const b = request.method === 'POST' ? await body(request) : {};
      // No awaits inside the transaction: claim, fencing, updates and event cursor commit together.
      return this.ctx.storage.transactionSync(() => {
        this.expire();
        if (op === 'history') return json({ runs: this.rows<any>('SELECT * FROM (SELECT * FROM runs ORDER BY created DESC, id DESC LIMIT 100) ORDER BY created, id'), cursor: this.rows<any>('SELECT COALESCE(MAX(cursor),0) AS n FROM events')[0].n });
        if (op === 'agents') return json({ agents: Object.keys(agentTokens(this.env)).map(id => {
          const w = this.rows<any>('SELECT * FROM workers WHERE agent=?', id)[0];
          return { id, worker: w?.worker || '', mode: w?.mode || '', seen: w?.seen || 0, online: !!w && w.seen > Date.now() - 15000 };
        }) });
        if (op === 'events') {
          const after = Number(new URL(request.url).searchParams.get('after') || 0);
          demand(Number.isSafeInteger(after) && after >= 0, 400, 'Invalid cursor');
          return json({ events: this.rows<any>('SELECT * FROM events WHERE cursor>? ORDER BY cursor LIMIT 500', after) });
        }
        if (op === 'send') {
          demand(validId(b.id) && (validId(b.agent) && Object.hasOwn(agentTokens(this.env), b.agent)) && typeof b.prompt === 'string' && b.prompt.trim() && b.prompt.length <= 12000, 400, 'Invalid prompt, id or agent');
          const existing = this.get(b.id);
          if (existing) { demand(existing.agent === b.agent && existing.prompt === b.prompt, 409, 'Id already used'); return json(existing); }
          demand(!this.rows<any>("SELECT id FROM runs WHERE agent=? AND status IN ('queued','running')", b.agent).length, 409, 'Agent busy in this room');
          this.sql.exec("INSERT INTO runs(id,agent,prompt,status,created) VALUES(?,?,?,'queued',?)", b.id, b.agent, b.prompt, Date.now());
          this.event(b.id, 'state', this.get(b.id));
          return json(this.get(b.id), 201);
        }
        if (op === 'cancel') {
          demand(validId(b.id), 400, 'Invalid id'); const r = this.get(b.id); demand(r, 404, 'Run not found');
          if (active(r.status)) { this.sql.exec("UPDATE runs SET status='cancelled' WHERE id=?", b.id); this.event(b.id, 'state', this.get(b.id)); }
          return json(this.get(b.id));
        }
        demand(validId(b.worker), 400, 'Invalid worker id');
        if (op === 'claim') {
          demand(validMode(b.mode), 400, 'Invalid mode');
          let s = this.rows<any>('SELECT * FROM sessions WHERE agent=?', agent!)[0];
          demand(!s || (s.worker_id === b.worker && s.mode === b.mode), 409, 'Session pinned to another worker or mode');
          this.sql.exec('INSERT INTO workers(agent,worker,mode,seen) VALUES(?,?,?,?) ON CONFLICT(agent) DO UPDATE SET worker=excluded.worker,mode=excluded.mode,seen=excluded.seen', agent!, b.worker, b.mode, Date.now());
          const r = this.rows<any>("SELECT * FROM runs WHERE agent=? AND status='queued' ORDER BY created LIMIT 1", agent!)[0];
          if (!r) return json({ task: null });
          if (!s) {
            s = { session_id: crypto.randomUUID(), initialized: 0 };
            this.sql.exec('INSERT INTO sessions(agent,session_id,worker_id,mode) VALUES(?,?,?,?)', agent!, s.session_id, b.worker, b.mode);
          }
          this.sql.exec("UPDATE runs SET status='running', mode=?, session_id=?, worker_id=?, lease=? WHERE id=?", b.mode, s.session_id, b.worker, Date.now() + 15000, r.id);
          this.event(r.id, 'state', this.get(r.id));
          return json({ task: { ...this.get(r.id), resume: !!s.initialized, provider_session_id: s.provider_session_id || '' } });
        }
        demand(validId(b.id), 400, 'Invalid run id');
        const r = this.get(b.id);
        demand(r && r.agent === agent && r.worker_id === b.worker, 409, 'Not run owner');
        if (op === 'heartbeat') {
          this.sql.exec('UPDATE workers SET seen=? WHERE agent=? AND worker=?', Date.now(), agent!, b.worker);
          if (r.status === 'running') this.sql.exec('UPDATE runs SET lease=? WHERE id=?', Date.now() + 15000, r.id);
          return json({ cancel: r.status !== 'running' });
        }
        demand(Number.isSafeInteger(b.seq) && b.seq > 0, 400, 'Invalid sequence');
        if (b.seq <= r.seq) return json({ accepted: true }); // retry after lost HTTP response
        demand(r.status === 'running' && b.seq === r.seq + 1, 409, 'Run stopped or out of order');
        const u = b.update;
        demand(u && ['delta','done','error','session','activity'].includes(u.kind), 400, 'Invalid update');
        if (u.kind === 'delta') {
          demand(typeof u.text === 'string' && u.text.length <= 16000 && r.text.length + u.text.length <= 1000000, 413, 'Output limit');
          this.sql.exec('UPDATE runs SET text=text || ? WHERE id=?', u.text, r.id);
          this.event(r.id, 'delta', { text: u.text });
        } else if (u.kind === 'session') {
          demand(u.providerSessionId === undefined || validSessionId(u.providerSessionId), 400, 'Invalid provider session');
          const s = this.rows<any>('SELECT provider_session_id FROM sessions WHERE agent=?', agent!)[0];
          demand(!s.provider_session_id || !u.providerSessionId || s.provider_session_id === u.providerSessionId, 409, 'Provider session changed');
          this.sql.exec("UPDATE sessions SET initialized=1, provider_session_id=CASE WHEN ?='' THEN provider_session_id ELSE ? END WHERE agent=?", u.providerSessionId || '', u.providerSessionId || '', agent!);
        } else if (u.kind === 'activity') {
          const a = u.activity;
          demand(a && (a.type === 'tool' || a.type === 'usage'), 400, 'Invalid activity');
          if (a.type === 'tool') {
            demand(Object.keys(a).every(key => ['type','name','status'].includes(key)) && typeof a.name === 'string' && /^[A-Za-z0-9_.:-]{1,128}$/.test(a.name) && ['started','completed','error'].includes(a.status), 400, 'Invalid tool activity');
            // Persist only an allowlisted summary; never accept arguments, paths, or provider payloads.
            this.event(r.id, 'activity', { type: 'tool', name: a.name, status: a.status });
          } else {
            demand(Object.keys(a).every(key => ['type','usage'].includes(key)) && a.usage && typeof a.usage === 'object' && !Array.isArray(a.usage), 400, 'Invalid usage');
            const allowed = ['input','output','cached','cost'];
            demand(Object.keys(a.usage).every(key => allowed.includes(key)), 400, 'Invalid usage');
            const usage = Object.fromEntries(Object.entries(a.usage));
            demand(Object.values(usage).every(n => typeof n === 'number' && Number.isFinite(n) && n >= 0), 400, 'Invalid usage');
            this.event(r.id, 'activity', { type: 'usage', usage });
          }
        } else {
          demand(u.kind !== 'error' || (typeof u.error === 'string' && u.error.length <= 2000), 400, 'Invalid error');
          this.sql.exec('UPDATE runs SET status=?, error=? WHERE id=?', u.kind, u.error || '', r.id);
          this.event(r.id, 'state', this.get(r.id));
        }
        this.sql.exec('UPDATE runs SET seq=?, lease=? WHERE id=?', b.seq, Date.now() + 15000, r.id);
        return json({ accepted: true });
      });
    } catch (e) { return errorResponse(e); }
  }
}
