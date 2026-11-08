// Graphspec run manifests: the files graphloop writes into <session dir>/graphs/*.json
// (manifest contract version 1, see packages/graphloop/src/manifest.rs). Readers are
// tolerant: unreadable files, malformed JSON, foreign versions and unknown fields are
// all skipped, and a manifest whose nodes are all gone is stale and ignored.
import { readdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { classify, parseModel } from './monitor.mjs';

const nonEmpty = (v) => (typeof v === 'string' && v.length ? v : undefined);

/** h1's session-dir rule, exactly as in session.rs / manifest.rs. */
export function sessionDir({ env = process.env, platform = process.platform } = {}) {
  const override = nonEmpty(env.H1_DIR);
  if (override) return override;
  if (platform === 'win32' && nonEmpty(env.LOCALAPPDATA)) return join(env.LOCALAPPDATA, 'h1', 'sessions');
  const base = nonEmpty(env.XDG_RUNTIME_DIR) || nonEmpty(env.TMPDIR) || tmpdir();
  return join(base, 'h1');
}

export function graphsDir(opts = {}) {
  return opts.dir ? opts.dir : join(sessionDir(opts), 'graphs');
}

function pickOf(node) {
  const p = node && typeof node.pick === 'object' && node.pick ? node.pick : {};
  return { via: typeof p.via === 'string' ? p.via : null, rule: typeof p.rule === 'string' ? p.rule : null, reason: typeof p.reason === 'string' ? p.reason : null };
}

// vault_env carries env NAMES whose values came from a vault (manifest.rs:
// names only, never values). Defence in depth: only entries shaped exactly
// like an env name pass; anything value-shaped (an '=' assignment, spaces,
// dashes, dots, a leading digit, a non-string) is dropped, never rendered.
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function vaultEnvOf(raw) {
  if (!Array.isArray(raw)) return [];
  const seen = new Set();
  const out = [];
  for (const v of raw) {
    if (typeof v !== 'string' || !ENV_NAME.test(v) || seen.has(v)) continue;
    seen.add(v);
    out.push(v);
  }
  return out;
}

function nodeOf(raw) {
  if (!raw || typeof raw !== 'object' || typeof raw.name !== 'string' || !raw.name) return null;
  return {
    name: raw.name,
    harness: typeof raw.harness === 'string' ? raw.harness : null,
    role: typeof raw.role === 'string' ? raw.role : null,
    parent: typeof raw.parent === 'string' ? raw.parent : null,
    requested_model: typeof raw.requested_model === 'string' ? raw.requested_model : null,
    model: typeof raw.model === 'string' ? raw.model : null,
    model_label: typeof raw.model_label === 'string' ? raw.model_label : null,
    pick: pickOf(raw),
    tools: Array.isArray(raw.tools) ? raw.tools.filter((t) => typeof t === 'string') : [],
    vault_env: vaultEnvOf(raw.vault_env),
  };
}

function manifestOf(raw) {
  if (!raw || typeof raw !== 'object' || raw.version !== 1 || !Array.isArray(raw.nodes)) return null;
  const nodes = raw.nodes.map(nodeOf).filter(Boolean);
  const edges = Array.isArray(raw.edges)
    ? raw.edges.filter((e) => e && typeof e.from === 'string' && typeof e.to === 'string').map((e) => ({ from: e.from, to: e.to, kind: typeof e.kind === 'string' ? e.kind.toLowerCase() : 'parent' }))
    : [];
  return {
    version: 1,
    run: typeof raw.run === 'string' ? raw.run : null,
    team: typeof raw.team === 'string' ? raw.team : null,
    source: typeof raw.source === 'string' ? raw.source : null,
    root: typeof raw.root === 'string' ? raw.root : null,
    created_ms: typeof raw.created_ms === 'number' ? raw.created_ms : 0,
    nodes,
    edges,
  };
}

/**
 * Load every valid manifest. `dir`, when given, is a session dir (its graphs/
 * subfolder is read) or the graphs folder itself, which keeps tests simple;
 * without it the session-dir rule above decides. Oldest run first.
 */
export async function loadGraphs({ dir, env, platform } = {}) {
  const candidates = dir ? [join(dir, 'graphs'), dir] : [join(sessionDir({ env, platform }), 'graphs')];
  let entries = null;
  let scan = null;
  for (const candidate of candidates) {
    try { entries = await readdir(candidate); scan = candidate; break; } catch { /* try the next shape, else no graphs */ }
  }
  if (!entries) return [];
  const out = [];
  for (const name of entries.filter((n) => n.endsWith('.json')).sort()) {
    try {
      const manifest = manifestOf(JSON.parse(await readFile(join(scan, name), 'utf8')));
      if (manifest) out.push(manifest);
    } catch { /* skip unreadable / malformed files */ }
  }
  out.sort((a, b) => a.created_ms - b.created_ms);
  return out;
}

export function graphspecOf(manifest, node) {
  return { team: manifest.team, run: manifest.run, harness: node.harness, model: node.model, model_label: node.model_label, requested_model: node.requested_model, pick: { ...node.pick }, tools: [...node.tools], vault_env: vaultEnvOf(node.vault_env) };
}

/**
 * Pure merge of live labs with manifests. Returns:
 * - labs: the live labs (unchanged fields, plus `graphspec` or null), with the
 *   PLANNED nodes (manifest nodes with no live lab, state 'planned') appended;
 * - planned: just those planned nodes;
 * - edges / memberEdges: the manifests' member edges between known nodes;
 * - teams: one { team, run, up, total } summary per active (non-stale) manifest.
 */
export function mergeGraphs(labs, manifests) {
  const live = Array.isArray(labs) ? labs : [];
  const liveNames = new Set(live.map((l) => l.name));
  const active = (Array.isArray(manifests) ? manifests : [])
    .map((m) => manifestOf(m))
    .filter(Boolean)
    .filter((m) => m.nodes.some((n) => liveNames.has(n.name)));
  const gsByName = new Map();
  const plannedByName = new Map();
  const memberEdges = [];
  const seenEdge = new Set();
  const teams = [];
  for (const manifest of active) {
    let up = 0;
    const names = new Set(manifest.nodes.map((n) => n.name));
    for (const node of manifest.nodes) {
      const graphspec = graphspecOf(manifest, node);
      if (liveNames.has(node.name)) { gsByName.set(node.name, graphspec); up += 1; continue; }
      if (plannedByName.has(node.name)) continue;
      const kids = manifest.nodes.filter((n) => n.parent === node.name);
      const model = parseModel(node.model);
      plannedByName.set(node.name, {
        name: node.name,
        role: node.role,
        kind: classify(node.role, kids.length > 0, Boolean(node.parent)),
        parent: node.parent && names.has(node.parent) ? node.parent : null,
        children: kids.map((n) => n.name),
        state: 'planned',
        model: node.model,
        modelLabel: model.label,
        modelFamily: model.family,
        quietMs: null,
        uptimeMs: null,
        title: null,
        cwd: null,
        pid: null,
        samples: [],
        usage: null,
        graphspec,
      });
    }
    teams.push({ team: manifest.team, run: manifest.run, up, total: manifest.nodes.length });
    const known = (name) => liveNames.has(name) || plannedByName.has(name);
    for (const edge of manifest.edges) {
      if (edge.kind !== 'member' || !known(edge.from) || !known(edge.to)) continue;
      const key = edge.from + '->' + edge.to;
      if (seenEdge.has(key)) continue;
      seenEdge.add(key);
      memberEdges.push({ from: edge.from, to: edge.to, kind: 'member' });
    }
  }
  const enriched = live.map((lab) => ({ ...lab, graphspec: gsByName.get(lab.name) ?? null }));
  const planned = [...plannedByName.values()];
  return { labs: [...enriched, ...planned], planned, edges: memberEdges, memberEdges, teams };
}
