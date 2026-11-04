// Evidence for the two-node PoC. Run with the secrets file as env (never printed):
//   node --env-file=$HOME/.dac-poc/env deploy/aws/verify.mjs https://<aws-host> http://127.0.0.1:18891
// Node A = AWS room owner (MOCK pi worker there). Node B = Codespace-equivalent gateway (MOCK claude worker there).
const [A, B] = process.argv.slice(2).map(u => u?.replace(/\/$/, ''));
const { CHAT_TOKEN, PI_TOKEN, CLAUDE_TOKEN } = process.env;
if (!A || !B || !CHAT_TOKEN || !PI_TOKEN || !CLAUDE_TOKEN) { console.error('usage: verify.mjs <nodeA-url> <nodeB-url> with CHAT_TOKEN/PI_TOKEN/CLAUDE_TOKEN in the environment'); process.exit(2); }
const ROOM = 'demo'; let failed = 0;
const check = (ok, label, extra = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${extra ? '  ' + extra : ''}`); if (!ok) failed++; };
const api = async (base, path, body, token = CHAT_TOKEN) => {
  const r = await fetch(`${base}/api/rooms/${ROOM}/${path}`, { method: body === undefined ? 'GET' : 'POST', headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, body: await r.json().catch(() => ({})) };
};
const health = async base => (await fetch(base + '/healthz')).json();
const waitDone = async (base, id) => { for (let i = 0; i < 100; i++) { const r = (await api(base, 'history')).body.runs.find(x => x.id === id); if (r && ['done', 'error'].includes(r.status)) return r; await new Promise(r => setTimeout(r, 300)); } return undefined; };

const [ha, hb] = [await health(A), await health(B)];
console.log(`node A: ${JSON.stringify(ha)}\nnode B: ${JSON.stringify(hb)}`);
check(ha.ok && hb.ok && ha.node !== hb.node, 'two distinct nodes are up', `(${ha.mode} + ${hb.mode})`);

// unauthenticated / wrong-token access is refused on both nodes
for (const [name, base] of [['A', A], ['B', B]]) {
  check((await api(base, 'history', undefined, '')).status === 401, `node ${name}: no token -> 401`);
  check((await api(base, 'history', undefined, 'x'.repeat(32))).status === 401, `node ${name}: wrong token -> 401`);
  check((await api(base, 'send', { id: 'x1', agent: 'pi', prompt: 'x' }, PI_TOKEN)).status === 401, `node ${name}: agent token cannot send as user -> 401`);
  check((await api(base, 'agent/pi/claim', { worker: 'w', mode: 'mock' }, CHAT_TOKEN)).status === 401, `node ${name}: user token cannot act as agent -> 401`);
}

const tag = Date.now().toString(36);
const viaB = `poc-b-${tag}`, viaA = `poc-a-${tag}`;
check((await api(B, 'send', { id: viaB, agent: 'pi', prompt: `sent through node B at ${tag}` })).status === 201, 'message sent through node B (Codespace-equivalent), addressed to pi');
const r1 = await waitDone(A, viaB);
check(r1?.status === 'done' && /^\[MOCK pi;/.test(r1.text), 'MOCK pi worker on the AWS node answered it', r1 && `worker=${r1.worker_id}`);
check((await api(A, 'history')).body.runs.some(r => r.id === viaB), 'message sent via B is visible through node A (AWS)');

check((await api(A, 'send', { id: viaA, agent: 'claude', prompt: `sent through node A at ${tag}` })).status === 201, 'message sent through node A (AWS), addressed to claude');
const r2 = await waitDone(B, viaA);
check(r2?.status === 'done' && /^\[MOCK claude;/.test(r2.text), 'MOCK claude worker on the Codespace-equivalent node answered it', r2 && `worker=${r2.worker_id}`);
check((await api(A, 'history')).body.runs.some(r => r.id === viaA), 'message sent via A is visible through node A (AWS)');

const [histA, histB] = [(await api(A, 'history')).body, (await api(B, 'history')).body];
check(JSON.stringify(histA.runs) === JSON.stringify(histB.runs) && histA.cursor === histB.cursor, 'both nodes return byte-identical room history', `(${histA.runs.length} runs, cursor ${histA.cursor})`);
const mine = histA.runs.filter(r => [viaA, viaB].includes(r.id));
for (const r of mine) console.log(`  run ${r.id}: agent=${r.agent} status=${r.status} worker=${r.worker_id} mode=${r.mode} text="${r.text.replace(/session [0-9a-f-]{36}/, 'session <id>')}"`);
console.log(failed ? `\n${failed} CHECK(S) FAILED` : '\nALL CHECKS PASSED (agents are MOCK: no LLM was called)');
process.exit(failed ? 1 : 0);
