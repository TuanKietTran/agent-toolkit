// Explicitly opt-in deployment only. This script is not invoked by build/test.
import { build } from 'esbuild';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

async function main() {
  if (process.env.CONFIRM_FLEET_DEPLOY !== 'YES') throw Error('Deployment disabled. Set CONFIRM_FLEET_DEPLOY=YES only after approving the target bucket/fleet.');
  const bucket = process.env.CELLD_BUCKET;
  if (!bucket?.startsWith('s3://')) throw Error('CELLD_BUCKET=s3://... required');
  const names = ['CHAT_TOKEN','PI_TOKEN','CLAUDE_TOKEN'] as const;
  const vars = Object.fromEntries(names.map(name => {
    const value = process.env[name];
    if (!value || value.length < 24 || value.includes('replace-with')) throw Error(`Set a strong ${name}`);
    return [name, value];
  }));
  if (new Set(Object.values(vars)).size !== 3) throw Error('Use three distinct tokens');
  const version = spawnSync('celld', ['--version'], { encoding: 'utf8' });
  if (version.status !== 0 || !/\b0\.6\.2\b/.test(version.stdout)) throw Error('celld v0.6.2 required on PATH');
  const dir = resolve('.deploy/app');
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await build({ entryPoints: ['src/worker.ts'], bundle: true, format: 'esm', outfile: dir + '/worker.js' });
  const config = dir + '/wrangler.json';
  try {
    await writeFile(config, JSON.stringify({ name: 'distributed-agent-chat', main: 'worker.js', compatibility_date: '2025-10-11',
      durable_objects: { bindings: [{ name: 'ROOMS', class_name: 'Room' }] }, migrations: [{ tag: 'v1', new_sqlite_classes: ['Room'] }], vars }), { mode: 0o600 });
    const args = ['deploy', dir, '--bucket', bucket];
    if (process.env.S3_ENDPOINT) args.push('--endpoint', process.env.S3_ENDPOINT);
    if (process.env.AWS_REGION) args.push('--region', process.env.AWS_REGION);
    // Capture output instead of logging it: a provider error could contain deployment configuration.
    const result = spawnSync('celld', args, { encoding: 'utf8', maxBuffer: 1024 * 1024 });
    if (result.status !== 0) throw Error('celld deploy failed (raw output suppressed to avoid leaking Worker vars).');
    console.log('Deployment committed to the configured bucket. Nodes may take 30 seconds to adopt it.');
  } finally { await rm(config, { force: true }); }
}
main().catch(e => { console.error(e instanceof Error ? e.message : 'Deployment failed'); process.exitCode = 1; });
