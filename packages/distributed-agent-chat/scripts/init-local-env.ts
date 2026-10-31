// Exclusive creation prevents replacement of existing secrets; never prints generated values.
import { randomBytes } from 'node:crypto';
import { open } from 'node:fs/promises';
import { resolve } from 'node:path';
import { validateSecrets } from '../src/auth';

const path = resolve(process.env.ENV_FILE || '.env');
const secret = () => randomBytes(32).toString('base64url');
async function main() {
  const tokens = { chat: secret(), pi: secret(), claude: secret(), codex: secret(), opencode: secret(), ollama: secret() };
  validateSecrets({ CHAT_TOKEN: tokens.chat, AGENT_TOKENS: JSON.stringify(Object.fromEntries(Object.entries(tokens).slice(1))) });
  const file = await open(path, 'wx', 0o600);
  try {
    await file.chmod(0o600);
    await file.writeFile([
      '# Generated local secrets; do not commit or share.',
      `CHAT_TOKEN=${tokens.chat}`,
      `AGENT_TOKENS=${JSON.stringify(Object.fromEntries(Object.entries(tokens).slice(1)))}`,
      'CHAT_HOST=127.0.0.1', 'CHAT_PORT=18877', 'CHAT_DATA_DIR=.data/miniflare', ''
    ].join('\n'));
    console.log(`Created ${path}; generated values were not printed.`);
  } finally { await file.close(); }
}
main().catch(e => {
  console.error((e as NodeJS.ErrnoException)?.code === 'EEXIST' ? `${path} already exists; refused to overwrite.` : 'Secret initialization failed.');
  process.exitCode = 1;
});
