// Starts one DAC node (server + one MOCK agent worker) in a single terminal.
// Used for the Codespace node and for local stand-ins: `npm run node:up`.
//   UPSTREAM_URL=https://owner.example   -> gateway node (shares the owner's rooms); unset -> owner node
//   AGENT_ID=claude|pi (default claude)  ROOM=demo  PORT=18890  HOST=127.0.0.1  NODE_NAME=...
// Tokens (CHAT_TOKEN, PI_TOKEN, CLAUDE_TOKEN) come from the environment (Codespaces secrets or --env-file); never logged.
import { spawn, type ChildProcess } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

const agent = process.env.AGENT_ID === 'pi' ? 'pi' : 'claude';
const port = process.env.PORT || '18890';
const token = process.env[`${agent.toUpperCase()}_TOKEN`];
if (!token) { console.error(`${agent.toUpperCase()}_TOKEN is not set (use a Codespaces secret or --env-file).`); process.exit(1); }
const name = process.env.NODE_NAME || (process.env.UPSTREAM_URL ? 'gateway' : 'owner');
const children: ChildProcess[] = [];
const run = (args: string[], env: Record<string, string>) => {
  const c = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', '--import', 'tsx', ...args], { stdio: 'inherit', env: { ...process.env, ...env } });
  children.push(c); return c;
};
const server = run(['src/node-server.ts'], { PORT: port, NODE_NAME: name });
const stop = () => { for (const c of children) c.kill('SIGTERM'); };
process.once('SIGINT', stop); process.once('SIGTERM', stop);
server.on('exit', code => { stop(); process.exitCode = code ?? 0; });
await delay(1500); // let the server bind; the worker also retries on its own
run(['src/agent/cli.ts'], { AGENT_MODE: 'mock', AGENT_ID: agent, WORKER_ID: `${agent}-${name}`, ROOM: process.env.ROOM || 'demo',
  AGENT_TOKEN: token, CHAT_URL: `http://127.0.0.1:${port}` });
console.log(`Node "${name}" up on port ${port}; MOCK ${agent} agent attached to room ${process.env.ROOM || 'demo'}. Ctrl+C stops both.`);
