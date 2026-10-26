// Local-only secrets. Exclusive creation prevents overwriting an existing fleet's credentials.
import { randomBytes } from 'node:crypto';
import { open } from 'node:fs/promises';
import { resolve } from 'node:path';

const path = resolve('.env');
const secret = () => randomBytes(32).toString('hex');
async function main() {
  const file = await open(path, 'wx', 0o600);
  try {
    await file.chmod(0o600);
    await file.writeFile([
      '# Generated local fleet secrets; never commit or print this file.',
      `MINIO_ROOT_USER=chat-${randomBytes(8).toString('hex')}`,
      `MINIO_ROOT_PASSWORD=${secret()}`,
      `CHAT_TOKEN=${secret()}`, `PI_TOKEN=${secret()}`, `CLAUDE_TOKEN=${secret()}`,
      'CHAT_PORT_A=18877', 'CHAT_PORT_B=18878', ''
    ].join('\n'));
    console.log('Created ignored .env with mode 0600; secret values were not printed.');
  } finally { await file.close(); }
}
main().catch(e => {
  console.error(e?.code === 'EEXIST' ? '.env already exists; refused to overwrite credentials.' : 'Local secret generation failed.');
  process.exitCode = 1;
});
