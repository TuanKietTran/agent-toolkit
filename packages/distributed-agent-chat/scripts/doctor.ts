import { access, readFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { agentTokens, validateSecrets } from '../src/auth';

const issues: string[] = [];
if (Number(process.versions.node.split('.')[0]) < 22) issues.push('Node.js 22 or newer is required');
try {
  const env = await readFile('.env', 'utf8');
  const vars: Record<string,string> = {};
  for (const line of env.split(/\r?\n/)) { const m = /^([A-Z0-9_]+)=(.*)$/.exec(line); if (m) vars[m[1]] = m[2]; }
  validateSecrets(vars as any);
  console.log(`Secrets configured safely for ${Object.keys(agentTokens(vars as any)).length} agent target(s).`);
} catch { issues.push('.env missing or secrets invalid; run npm run setup (values will not be printed)'); }
try { await access('dist/worker.js', constants.R_OK); } catch { issues.push('dist/worker.js missing; run npm run build'); }
if (issues.length) { for (const issue of issues) console.error(`FAIL: ${issue}`); process.exitCode = 1; }
else console.log('Doctor checks passed.');
