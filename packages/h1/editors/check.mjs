// Regex-level checks for the Graphspec TextMate grammar. No dependencies.
// Usage: node check.mjs   (run from editors/)
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
let failures = 0;
const ok = (cond, label) => {
  console.log(`${cond ? 'PASS' : 'FAIL'} ${label}`);
  if (!cond) failures += 1;
};

const grammar = JSON.parse(readFileSync(join(here, 'yah.tmLanguage.json'), 'utf8'));
const langConf = JSON.parse(readFileSync(join(here, 'language-configuration.json'), 'utf8'));
ok(true, 'both JSON files parse');
ok(grammar.scopeName === 'source.yah', 'scopeName is source.yah');
ok(Array.isArray(grammar.fileTypes) && grammar.fileTypes.includes('yah'), 'fileTypes includes yah');
ok(langConf.comments && langConf.comments.lineComment === '//', 'language-configuration lineComment is //');

// Every match/begin/end regex must compile in Node.
const regexes = [];
const walk = (node) => {
  if (Array.isArray(node)) return node.forEach(walk);
  if (node && typeof node === 'object') {
    for (const [k, v] of Object.entries(node)) {
      if ((k === 'match' || k === 'begin' || k === 'end') && typeof v === 'string') regexes.push([k, v]);
      else walk(v);
    }
  }
};
walk(grammar);
let compiled = 0;
for (const [kind, src] of regexes) {
  try { new RegExp(src); compiled += 1; }
  catch (e) { ok(false, `regex compiles (${kind}: ${src}): ${e.message}`); }
}
ok(compiled === regexes.length && compiled > 0, `all ${regexes.length} grammar regexes compile`);

// Tokenise samples: the canonical fixture plus examples/ when present.
const samples = [];
const fixture = join(here, '..', 'tests', 'fixtures', 'canonical.yah');
if (existsSync(fixture)) samples.push(fixture);
const examplesDir = join(here, '..', 'examples');
if (existsSync(examplesDir)) for (const f of readdirSync(examplesDir)) if (f.endsWith('.yah')) samples.push(join(examplesDir, f));
ok(samples.length > 0, `found ${samples.length} sample .yah file(s)`);

const repo = grammar.repository;
const rx = (entry) => new RegExp(entry.match || entry.begin);
// Vault sample lines: the vault block kind and ${vault.NAME.KEY} references.
const vaultLine = 'vault "local" {';
ok(rx(repo['block-label']).test(vaultLine), 'vault sample: block-label pattern hits vault "local"');
ok(rx(repo.keyword).test(vaultLine), 'vault sample: block keyword pattern hits vault');
const vaultRef = '"${vault.local.FLEET_TOKEN}"';
ok(rx(repo.interpolation).test(vaultRef), 'vault sample: interpolation begin pattern hits ${vault...}');
ok(rx(repo.reference).test(vaultRef), 'vault sample: reference pattern hits vault.local.FLEET_TOKEN');
const vaultHead = repo.interpolation.patterns[0];
ok(new RegExp(vaultHead.match).test('vault'), 'vault sample: interpolation support.variable pattern hits vault');

for (const path of samples) {
  const text = readFileSync(path, 'utf8');
  const name = path.split('/').slice(-2).join('/');
  const firstCode = text.split('\n').map((l) => l.trim()).find((l) => l && !l.startsWith('//')) || '';
  ok(rx(repo.header).test(firstCode), `${name}: header pattern matches first line`);
  ok(rx(repo.keyword).test(text), `${name}: block keyword pattern hits`);
  ok(rx(repo.comment).test('// x') && (text.includes('//') ? rx(repo.comment).test(text) : true), `${name}: comment pattern ok`);
  if (text.includes('${')) ok(rx(repo.interpolation).test(text), `${name}: interpolation begin pattern hits`);
  if (/(env|var|harnesses|vault)\./.test(text)) ok(rx(repo.reference).test(text), `${name}: reference pattern hits`);
}
console.log(failures === 0 ? 'check.mjs: PASS' : `check.mjs: ${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
