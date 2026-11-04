import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// A fake `gh` keeps accounts in a state file; it also emits a token-shaped string to prove the CLI never shows one.
const CANARY = 'ghp_' + 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8';
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'gh-accounts-'));
  const state = join(dir, 'state.json'); writeFileSync(state, JSON.stringify([{ login: 'alice', active: true, state: 'success' }, { login: 'bob', active: false, state: 'success' }]));
  const fake = join(dir, 'gh'); writeFileSync(fake, `#!/usr/bin/env node
const fs = require('fs'); const f = ${JSON.stringify(state)}; const a = process.argv.slice(2); const s = JSON.parse(fs.readFileSync(f, 'utf8'));
const user = a[a.indexOf('--user') + 1];
if (a[0] === 'auth' && a[1] === 'status') { console.log(JSON.stringify(s)); }
else if (a[0] === 'auth' && a[1] === 'switch') { if (!s.some(x => x.login === user)) { console.error('no such account, token ${CANARY}'); process.exit(1); } s.forEach(x => x.active = x.login === user); fs.writeFileSync(f, JSON.stringify(s)); console.error('Switched; token ${CANARY}'); }
else if (a[0] === 'auth' && a[1] === 'logout') { const rest = s.filter(x => x.login !== user); if (rest.length && !rest.some(x => x.active)) rest[0].active = true; fs.writeFileSync(f, JSON.stringify(rest)); }
else if (a[0] === 'api') { console.log('4242'); }
else process.exit(2);
`);
  chmodSync(fake, 0o755);
  const repo = join(dir, 'repo'); mkdirSync(repo); execFileSync('git', ['init', '-q', repo]);
  const env = { ...process.env, GH_BIN: fake, GH_ACCOUNTS_CONFIG: join(dir, 'cfg', 'map.json'), GH_TOKEN: '', GITHUB_TOKEN: '' };
  const run = (...args: string[]) => spawnSync(process.execPath, ['scripts/gh-accounts.mjs', ...args], { encoding: 'utf8', env });
  const active = () => (JSON.parse(readFileSync(state, 'utf8')) as any[]).find(x => x.active).login;
  return { dir, repo, run, active, env };
}

test('gh-accounts: list, switch, map, run-and-restore, remove; never prints a token', () => {
  const t = fixture(); const all: string[] = [];
  const go = (...a: string[]) => { const r = t.run(...a); all.push(r.stdout, r.stderr); return r; };
  assert.match(go('list').stdout, /\* alice\s+\(active\)[\s\S]*bob/);
  assert.match(go('switch', 'bob').stdout, /now bob/); assert.equal(t.active(), 'bob');
  assert.equal(go('switch', 'nobody').status, 1);                      // unknown account refused before touching gh
  assert.equal(go('switch', 'bad name!').status, 1);
  assert.match(go('map', t.repo, 'alice').stdout, /alice/);          // alice is not active: falls back to the plain no-reply email
  assert.equal(execFileSync('git', ['-C', t.repo, 'config', 'user.name'], { encoding: 'utf8' }).trim(), 'alice');
  assert.equal(execFileSync('git', ['-C', t.repo, 'config', 'user.email'], { encoding: 'utf8' }).trim(), 'alice@users.noreply.github.com');
  assert.equal(statSync(t.env.GH_ACCOUNTS_CONFIG).mode & 0o777, 0o600);
  assert.match(go('current', t.repo).stdout, /MISMATCH/);
  const r = go('run', '--dir', t.repo, '--', process.execPath, '-e', `console.log('ran')`);
  assert.equal(r.status, 0); assert.match(r.stdout, /ran/); assert.equal(t.active(), 'bob', 'previous account restored after run');
  assert.match(go('use', t.repo).stdout, /now alice/); assert.equal(t.active(), 'alice');
  assert.equal(go('remove', 'bob').status, 1, 'remove needs --yes without a TTY');
  assert.match(go('remove', 'bob', '--yes').stdout, /Logged bob out/);
  assert.equal(go('help').status, 0);
  const text = all.join('\n'); assert.ok(!text.includes(CANARY), 'no token in any output'); assert.ok(!/ghp_/.test(text));
});

test('gh-accounts: switching is refused when an environment token pins the account (Codespace)', () => {
  const t = fixture();
  const r = spawnSync(process.execPath, ['scripts/gh-accounts.mjs', 'switch', 'bob'], { encoding: 'utf8', env: { ...t.env, GITHUB_TOKEN: 'placeholder-not-a-token' } });
  assert.equal(r.status, 1); assert.match(r.stderr, /GITHUB_TOKEN/); assert.equal(t.active(), 'alice');
  assert.match(spawnSync(process.execPath, ['scripts/gh-accounts.mjs', 'list'], { encoding: 'utf8', env: { ...t.env, GITHUB_TOKEN: 'placeholder-not-a-token' } }).stdout, /token from environment/);
});
