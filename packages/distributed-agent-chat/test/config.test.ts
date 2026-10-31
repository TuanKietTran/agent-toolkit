import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const port = '18877';
const text = (path: string) => readFileSync(path, 'utf8');

test('coordinator, setup, example, worker and dev defaults agree on port 18877', () => {
  const server = text('scripts/server.ts');
  const setup = text('scripts/init-local-env.ts');
  const example = text('.env.example');
  const cli = text('src/agent/cli.ts');
  const pkg = JSON.parse(text('package.json')) as { scripts: Record<string, string> };

  assert.match(server, /process\.env\.CHAT_PORT\s*\|\|\s*['"]18877['"]/);
  assert.match(setup, /['"]CHAT_PORT=18877['"]/);
  assert.match(example, /^CHAT_PORT=18877$/m);
  const defaultUrl = cli.match(/process\.env\.CHAT_URL\s*\|\|\s*['"]http:\/\/127\.0\.0\.1:(\d+)['"]/);
  assert.ok(defaultUrl, 'worker must have a default URL port');
  assert.equal(defaultUrl[1], port);
  assert.match(pkg.scripts.dev, /--port\s+18877(?:\s|$)/);
});
