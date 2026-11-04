// Bundles the portable node server and the agent worker CLI into two small ESM files for hosts without a checkout.
import { build } from 'esbuild';
const common = { bundle: true, platform: 'node', format: 'esm', target: 'node22', minify: true, legalComments: 'none', external: ['node:*'] };
await build({ ...common, entryPoints: ['src/node-server.ts'], outfile: 'dist/node-server.mjs' });
await build({ ...common, entryPoints: ['src/agent/cli.ts'], outfile: 'dist/agent-cli.mjs' });
console.log('dist/node-server.mjs dist/agent-cli.mjs');
