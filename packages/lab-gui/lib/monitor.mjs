// Turns the CLI's own JSON (list / status / screen) into one snapshot the page draws:
// graph, role kind, state, model, activity history and token/cost counters.

/** Roles the page draws with their own shape and colour. Anything else falls back to manager/worker/lab. */
export const TEAM_ROLES = ["builder", "explorer", "advisor"];

export function classify(role, hasChildren, hasParent) {
  if (TEAM_ROLES.includes(role) || role === "manager" || role === "worker") return role;
  if (role === "commander") return "commander";
  if (hasChildren) return hasParent ? "manager" : "commander";
  return hasParent ? "worker" : "lab";
}

/** "provider/id" -> {provider, id, family}. family drives the small model badge. */
export function parseModel(model) {
  if (typeof model !== "string" || !model) return { provider: "", id: "", family: "unknown", label: "unknown" };
  const slash = model.indexOf("/");
  const provider = slash > 0 ? model.slice(0, slash) : "";
  const id = slash > 0 ? model.slice(slash + 1) : model;
  const lower = id.toLowerCase();
  let family = "other";
  if (lower.includes("opus")) family = "opus";
  else if (lower.includes("sonnet")) family = "sonnet";
  else if (lower.includes("haiku")) family = "haiku";
  else if (lower.includes("fable")) family = "fable";
  else if (lower.startsWith("muse")) family = "muse";
  else if (provider === "opencode-cli" || lower.startsWith("opencode")) family = "opencode";
  return { provider, id, family, label: id.replace(/^claude-/, "") };
}

const UNIT = { k: 1e3, K: 1e3, M: 1e6 };
const NUM = String.raw`\d+(?:\.\d+)?`;
const num = (text) => {
  if (text === undefined) return undefined;
  const m = new RegExp(`^(${NUM})([kKM]?)$`).exec(text);
  return m ? Number.parseFloat(m[1]) * (UNIT[m[2]] ?? 1) : undefined;
};
// ↑in ↓out [R… W…] [CH…%] [$cost] [ctx%/window]; the window is only taken when it is not cut off by the screen edge.
const FOOTER = new RegExp(
  String.raw`↑\s*(${NUM}[kKM]?)\s+↓\s*(${NUM}[kKM]?)((?:\s+[RW]${NUM}[kKM]?)*)(?:\s+CH(${NUM})%)?(?:\s+\$(${NUM}))?(?:\s+(${NUM})%/(?:(${NUM}[kKM]?)(?![\d.…kKM]))?)?`,
);

/**
 * Reads Pi's footer line, e.g. `↑6 ↓350 R31k W23k CH36.7% $0.005 9.0%/200k (auto)`.
 * Returns undefined when the screen has no such line (not a Pi lab, or nothing sent yet).
 */
export function parseUsage(lines) {
  for (let i = lines.length - 1; i >= 0; i--) {
    const m = FOOTER.exec(lines[i]);
    if (!m) continue;
    const read = new RegExp(`\\bR(${NUM}[kKM]?)`).exec(m[3] ?? "");
    const write = new RegExp(`\\bW(${NUM}[kKM]?)`).exec(m[3] ?? "");
    return {
      input: num(m[1]),
      output: num(m[2]),
      cacheRead: num(read?.[1]),
      cacheWrite: num(write?.[1]),
      cacheHitPct: m[4] === undefined ? undefined : Number.parseFloat(m[4]),
      costUsd: m[5] === undefined ? undefined : Number.parseFloat(m[5]),
      contextPct: m[6] === undefined ? undefined : Number.parseFloat(m[6]),
      // Pi always prints the window with a unit (200k); a bare number means the screen cut it off.
      contextWindow: num(m[7]) >= 1000 ? num(m[7]) : undefined,
    };
  }
  return undefined;
}

async function mapPool(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

export function createMonitor({ cli, historyLen = 48, usageEveryMs = 6000, goneKeepMs = 60000, now = () => Date.now(), concurrency = 6 } = {}) {
  const history = new Map(); // name -> {lastBytes, samples[]}
  const usageCache = new Map(); // name -> {at, usage}
  const gone = new Map(); // name -> {lab, at}
  let snapshot = { at: 0, labs: [], totals: { total: 0, working: 0, asking: 0, stalled: 0, gone: 0, costUsd: 0, tokens: 0 }, error: null };
  let inflight;

  async function probe(entry) {
    const name = entry.name;
    let status;
    try {
      status = await cli.status(name);
    } catch {
      status = undefined;
    }
    const h = history.get(name) ?? { lastBytes: undefined, samples: [] };
    if (status && typeof status.bytes_out === "number") {
      const delta = h.lastBytes === undefined ? 0 : Math.max(0, status.bytes_out - h.lastBytes);
      h.lastBytes = status.bytes_out;
      h.samples.push(delta);
      if (h.samples.length > historyLen) h.samples.shift();
    }
    history.set(name, h);

    let usage = usageCache.get(name)?.usage;
    const cached = usageCache.get(name);
    if (status && (!cached || now() - cached.at >= usageEveryMs)) {
      try {
        const screen = await cli.screen(name, 8);
        usage = parseUsage(screen.lines ?? []);
      } catch {
        /* keep the previous reading */
      }
      usageCache.set(name, { at: now(), usage });
    }
    return { entry, status, usage, samples: [...h.samples] };
  }

  async function tick() {
    if (inflight) return inflight;
    inflight = (async () => {
      try {
        const entries = await cli.list();
        const probes = await mapPool(entries, concurrency, probe);
        const names = new Set(entries.map((e) => e.name));
        const kids = new Map();
        for (const e of entries) if (e.parent && names.has(e.parent)) kids.set(e.parent, [...(kids.get(e.parent) ?? []), e.name]);

        const labs = probes.map(({ entry, status, usage, samples }) => {
          const children = kids.get(entry.name) ?? [];
          const parent = entry.parent && names.has(entry.parent) ? entry.parent : null;
          const model = parseModel(entry.model);
          return {
            name: entry.name,
            role: entry.role ?? null,
            kind: classify(entry.role, children.length > 0, Boolean(parent)),
            parent,
            children,
            state: status ? status.state ?? entry.state ?? "working" : entry.state ?? "stalled",
            model: entry.model ?? null,
            modelLabel: model.label,
            modelFamily: model.family,
            quietMs: status?.quiet_ms ?? null,
            uptimeMs: status?.uptime_ms ?? null,
            title: status?.window_title ?? entry.title ?? null,
            cwd: entry.cwd ?? null,
            pid: entry.pid ?? null,
            samples,
            usage: usage ?? null,
          };
        });

        // A lab that vanished stays on the board for a minute as "gone" so a crash is noticed.
        for (const lab of labs) gone.delete(lab.name);
        for (const name of [...history.keys()]) {
          if (names.has(name)) continue;
          const last = snapshot.labs.find((l) => l.name === name);
          if (last && !gone.has(name)) gone.set(name, { lab: { ...last, state: "gone", children: [] }, at: now() });
          history.delete(name);
          usageCache.delete(name);
        }
        for (const [name, g] of gone) if (now() - g.at > goneKeepMs) gone.delete(name);
        const all = [...labs, ...[...gone.values()].map((g) => g.lab)];
        for (const l of all) {
          if (l.parent && !all.some((x) => x.name === l.parent)) l.parent = null;
        }

        const count = (s) => all.filter((l) => l.state === s).length;
        snapshot = {
          at: now(),
          labs: all,
          totals: {
            total: all.length,
            working: all.filter((l) => l.state === "working" || l.state === "up").length,
            asking: count("asking"),
            stalled: count("stalled"),
            gone: count("gone"),
            costUsd: all.reduce((s, l) => s + (l.usage?.costUsd ?? 0), 0),
            tokens: all.reduce((s, l) => s + (l.usage ? (l.usage.input ?? 0) + (l.usage.output ?? 0) + (l.usage.cacheRead ?? 0) + (l.usage.cacheWrite ?? 0) : 0), 0),
          },
          error: null,
        };
      } catch (error) {
        snapshot = { ...snapshot, at: now(), error: error instanceof Error ? error.message : String(error) };
      } finally {
        inflight = undefined;
      }
      return snapshot;
    })();
    return inflight;
  }

  return { tick, snapshot: () => snapshot };
}
