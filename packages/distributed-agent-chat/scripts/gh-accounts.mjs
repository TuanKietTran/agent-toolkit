#!/usr/bin/env node
// gh-accounts: switch between several GitHub accounts using the `gh` CLI. No dependencies. NEVER prints tokens.
//
//   gh-accounts list                         accounts and which one is active
//   gh-accounts switch <user>                make <user> the active gh account
//   gh-accounts add                          device-flow login (you finish it in the browser); never prompts for a token
//   gh-accounts remove <user> [--yes]        log one account out of gh
//   gh-accounts map <dir> <user> [--name N] [--email E]
//                                            remember dir -> account and set that repo's git user.name / user.email
//   gh-accounts current [dir]                which account a directory maps to vs. which is active
//   gh-accounts use [dir]                    switch gh to the account mapped to dir (default: cwd)
//   gh-accounts run [--dir D] [--keep] -- <command...>
//                                            switch to the mapped account, run the command (git push, gh codespace ...),
//                                            then restore the previously active account (unless --keep)
//   gh-accounts unmap <dir>                  forget a mapping
//
// Env: GH_BIN (gh executable, default "gh"), GH_HOST (default github.com), GH_ACCOUNTS_CONFIG (map file,
// default ~/.config/gh-accounts/map.json; holds directories and usernames only, mode 0600).
// Inside a Codespace (or whenever GH_TOKEN / GITHUB_TOKEN is set) gh is pinned to that single injected token:
// list/current/map work, but switch/add/remove are refused because the token env var always wins over stored accounts.
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';

const GH = process.env.GH_BIN || 'gh';
const HOST = process.env.GH_HOST || 'github.com';
const CONFIG = process.env.GH_ACCOUNTS_CONFIG || join(homedir(), '.config', 'gh-accounts', 'map.json');
const USER_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const envToken = () => Boolean(process.env.GH_TOKEN || process.env.GITHUB_TOKEN);

// Defense in depth: anything that looks like a GitHub token is masked before it can reach the terminal.
const redact = s => String(s).replace(/\b(gh[pousr]_[A-Za-z0-9]{16,}|github_pat_[A-Za-z0-9_]{20,})\b/g, '[redacted]');
const out = s => process.stdout.write(redact(s) + '\n');
const err = s => process.stderr.write(redact(s) + '\n');
class Fail extends Error {}
const fail = m => { throw new Fail(m); };

function gh(args, { input, env } = {}) {
  try {
    return execFileSync(GH, args, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], input, env: { ...process.env, ...env }, maxBuffer: 1 << 20 });
  } catch (e) {
    if (e.code === 'ENOENT') fail('gh CLI not found on PATH (https://cli.github.com).');
    fail(redact(`gh ${args[0]} ${args[1] || ''} failed: ${(e.stderr || e.message || '').toString().split('\n')[0]}`.trim()));
  }
}

// Accounts for HOST: [{login, active}]. Prefers `gh auth status --json hosts` (no token fields are requested), falls back to parsing text.
function accounts() {
  let raw;
  try { raw = execFileSync(GH, ['auth', 'status', '--hostname', HOST, '--json', 'hosts', '--jq', `.hosts["${HOST}"] // [] | map({login, active, state})`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }); }
  catch (e) {
    if (e.code === 'ENOENT') fail('gh CLI not found on PATH (https://cli.github.com).');
    raw = null;
  }
  if (raw) { try { return JSON.parse(raw).filter(a => a.login && a.state === 'success'); } catch { /* fall through */ } }
  // Fallback for older gh versions: text output (stdout and stderr), token lines are never read.
  const r = spawnSync(GH, ['auth', 'status', '--hostname', HOST], { encoding: 'utf8' });
  const list = []; let last;
  for (const line of `${r.stdout || ''}\n${r.stderr || ''}`.split('\n')) {
    const m = /Logged in to \S+ account (\S+)/.exec(line) || /Logged in to \S+ as (\S+)/.exec(line);
    if (m) { last = { login: m[1], active: false }; list.push(last); }
    else if (last && /Active account:\s*true/.test(line)) last.active = true;
  }
  if (list.length === 1) list[0].active = true;
  return list;
}
const active = list => list.find(a => a.active)?.login;
const requireUser = (list, user) => {
  if (!user || !USER_RE.test(user)) fail('Give a valid GitHub username.');
  const hit = list.find(a => a.login.toLowerCase() === user.toLowerCase());
  if (!hit) fail(`"${user}" is not logged in to gh. Logged in: ${list.map(a => a.login).join(', ') || '(none)'}. Add it with: gh-accounts add`);
  return hit.login;
};
const noEnvToken = what => { if (envToken()) fail(`${what} is not available while GH_TOKEN/GITHUB_TOKEN is set (e.g. in a Codespace): that token always wins. Unset it to manage stored accounts.`); };

function readMap() {
  if (!existsSync(CONFIG)) return {};
  try { const m = JSON.parse(readFileSync(CONFIG, 'utf8')); return m && typeof m === 'object' && !Array.isArray(m) ? m : {}; } catch { fail(`Unreadable map file ${CONFIG}`); }
}
function writeMap(map) {
  mkdirSync(dirname(CONFIG), { recursive: true, mode: 0o700 });
  const tmp = `${CONFIG}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(map, null, 2) + '\n', { mode: 0o600 }); chmodSync(tmp, 0o600); renameSync(tmp, CONFIG);
}
const norm = d => resolve(d || process.cwd()).replace(/[\\/]+$/, '') || sep;
// Longest-prefix match so subdirectories of a mapped repo use the same account.
function lookup(dir) {
  const d = norm(dir), map = readMap();
  const key = Object.keys(map).filter(k => d === k || d.startsWith(k + sep)).sort((x, y) => y.length - x.length)[0];
  return key ? { dir: key, ...map[key] } : undefined;
}
function switchTo(list, user) {
  if (active(list) === user) return false;
  noEnvToken('Switching accounts');
  gh(['auth', 'switch', '--hostname', HOST, '--user', user]);
  return true;
}
function flag(args, name) { const i = args.indexOf(name); if (i < 0) return undefined; const v = args[i + 1]; if (!v || v.startsWith('--')) fail(`${name} needs a value`); args.splice(i, 2); return v; }
function bool(args, name) { const i = args.indexOf(name); if (i < 0) return false; args.splice(i, 1); return true; }

const commands = {
  list() {
    const list = accounts();
    if (!list.length) return out(`No accounts logged in to ${HOST}. Run: gh-accounts add`);
    out(`GitHub accounts on ${HOST}${envToken() ? ' (token from environment, e.g. Codespace)' : ''}:`);
    for (const a of list) out(`  ${a.active ? '*' : ' '} ${a.login}${a.active ? '  (active)' : ''}`);
  },
  switch([user]) {
    const list = accounts(), target = requireUser(list, user);
    out(switchTo(list, target) ? `Active account is now ${target}.` : `${target} is already active.`);
  },
  add() {
    noEnvToken('Adding an account');
    const before = accounts();
    out('Starting GitHub device-flow login. Copy the one-time code, finish it in the browser, then return here.');
    const r = spawnSync(GH, ['auth', 'login', '--hostname', HOST, '--git-protocol', 'https', '--web', '--skip-ssh-key'], { stdio: 'inherit' });
    if (r.status !== 0) fail('Login did not complete; nothing was added.');
    const after = accounts(), added = after.filter(a => !before.some(b => b.login === a.login)).map(a => a.login);
    out(added.length ? `Added: ${added.join(', ')}. Active account: ${active(after)}.` : `No new account (you may have re-logged an existing one). Active account: ${active(after)}.`);
  },
  remove(args) {
    const yes = bool(args, '--yes'), list = accounts(), target = requireUser(list, args[0]);
    noEnvToken('Removing an account');
    if (!yes) {
      if (!process.stdin.isTTY) fail(`Refusing to log out ${target} without --yes.`);
      const answer = spawnSync('sh', ['-c', 'printf "Log %s out of gh? [y/N] " "$1" >&2; read a; echo "$a"', 'sh', target], { stdio: ['inherit', 'pipe', 'inherit'], encoding: 'utf8' }).stdout.trim();
      if (!/^y(es)?$/i.test(answer)) return out('Cancelled.');
    }
    gh(['auth', 'logout', '--hostname', HOST, '--user', target]);
    const after = accounts();
    const map = readMap(); let changed = false;
    for (const k of Object.keys(map)) if (map[k].user === target) { delete map[k]; changed = true; }
    if (changed) writeMap(map);
    out(`Logged ${target} out of gh${changed ? ' and dropped its directory mappings' : ''}. Active account: ${active(after) || '(none)'}.`);
  },
  map(args) {
    const name = flag(args, '--name'), email = flag(args, '--email');
    const [dir, user] = args; if (!dir || !user) fail('Usage: gh-accounts map <dir> <user> [--name N] [--email E]');
    const list = accounts(), target = requireUser(list, user), d = norm(dir);
    if (!existsSync(d) || !statSync(d).isDirectory()) fail(`Not a directory: ${d}`);
    try { execFileSync('git', ['-C', d, 'rev-parse', '--git-dir'], { stdio: 'ignore' }); } catch { fail(`${d} is not inside a git repository.`); }
    // Default name = login; default email = GitHub no-reply (numeric id form when it can be looked up for the active account).
    let gitEmail = email;
    if (!gitEmail && active(list) === target) { try { const id = gh(['api', 'user', '--jq', '.id']).trim(); if (/^\d+$/.test(id)) gitEmail = `${id}+${target}@users.noreply.github.com`; } catch { /* fall back below */ } }
    gitEmail ||= `${target}@users.noreply.github.com`;
    execFileSync('git', ['-C', d, 'config', 'user.name', name || target]);
    execFileSync('git', ['-C', d, 'config', 'user.email', gitEmail]);
    const map = readMap(); map[d] = { user: target }; writeMap(map);
    out(`${d} -> ${target}; repo git user.name="${name || target}" user.email="${gitEmail}".`);
  },
  unmap([dir]) { const map = readMap(), d = norm(dir); if (!map[d]) return out(`No mapping for ${d}.`); delete map[d]; writeMap(map); out(`Removed mapping for ${d} (git config left unchanged).`); },
  current([dir]) {
    const list = accounts(), m = lookup(dir), act = active(list);
    out(`directory : ${norm(dir)}`); out(`mapped to : ${m ? `${m.user} (via ${m.dir})` : '(no mapping)'}`); out(`gh active : ${act || '(none)'}`);
    if (m && act && m.user.toLowerCase() !== act.toLowerCase()) out(`MISMATCH: run "gh-accounts use" before pushing.`);
  },
  use([dir]) {
    const m = lookup(dir); if (!m) fail(`No account mapped for ${norm(dir)}. Run: gh-accounts map <dir> <user>`);
    const list = accounts(), target = requireUser(list, m.user);
    if (envToken()) { const act = active(list); if (act && act.toLowerCase() !== target.toLowerCase()) fail(`Environment token belongs to ${act}, not ${target}.`); return out(`Token account ${act || target} matches mapping.`); }
    out(switchTo(list, target) ? `Active account is now ${target} (for ${m.dir}).` : `${target} is already active.`);
  },
  run(args) {
    const split = args.indexOf('--'); if (split < 0 || split === args.length - 1) fail('Usage: gh-accounts run [--dir D] [--keep] -- <command...>');
    const own = args.slice(0, split), cmd = args.slice(split + 1);
    const dir = flag(own, '--dir'), keep = bool(own, '--keep');
    const m = lookup(dir); if (!m) fail(`No account mapped for ${norm(dir)}. Run: gh-accounts map <dir> <user>`);
    const list = accounts(), target = requireUser(list, m.user), before = active(list);
    if (envToken()) { if (before && before.toLowerCase() !== target.toLowerCase()) fail(`Environment token belongs to ${before}, not ${target}; refusing to run.`); }
    const switched = !envToken() && switchTo(list, target);
    if (switched) err(`gh-accounts: using ${target} for this command${keep ? '' : ` (will restore ${before})`}`);
    let status = 1;
    try { status = spawnSync(cmd[0], cmd.slice(1), { stdio: 'inherit', cwd: dir ? norm(dir) : undefined }).status ?? 1; }
    finally { if (switched && !keep && before) { try { gh(['auth', 'switch', '--hostname', HOST, '--user', before]); err(`gh-accounts: restored ${before}`); } catch (e) { err(`gh-accounts: could not restore ${before}: ${e.message}`); } } }
    process.exitCode = status;
  },
  help() { out(readFileSync(new URL(import.meta.url), 'utf8').split('\n').filter(l => l.startsWith('//')).slice(0, 24).map(l => l.slice(3)).join('\n')); }
};

try {
  const [cmd = 'help', ...rest] = process.argv.slice(2);
  if (!Object.hasOwn(commands, cmd)) fail(`Unknown command "${cmd}". Try: gh-accounts help`);
  commands[cmd](rest);
} catch (e) {
  err(e instanceof Fail ? `gh-accounts: ${e.message}` : 'gh-accounts: unexpected error');
  process.exitCode = process.exitCode || 1;
}
