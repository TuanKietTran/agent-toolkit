// A fake h1: sessions are plain objects, calls are recorded. No process, no socket.
export function createFakeCli(initial = []) {
  const sessions = new Map(initial.map((s) => [s.name, { bytes_out: 0, state: "working", quiet_ms: 10, uptime_ms: 1000, lines: [], ...s }]));
  const calls = [];
  const cli = {
    calls,
    sessions,
    list: async () => [...sessions.values()].map(({ name, role, parent, model, cwd, state, pid }) => ({ name, role: role ?? null, parent: parent ?? null, model: model ?? null, cwd: cwd ?? "/work", state, pid: pid ?? 1 })),
    status: async (name) => {
      const s = sessions.get(name);
      if (!s) throw new Error("no such lab");
      return { name, state: s.state, bytes_out: s.bytes_out, quiet_ms: s.quiet_ms, uptime_ms: s.uptime_ms, window_title: s.title ?? name };
    },
    screen: async (name, tail) => {
      calls.push(["screen", name, tail]);
      const s = sessions.get(name);
      if (!s) throw new Error("no such lab");
      return { lines: s.lines, cols: 120, rows: 36, title: name };
    },
    send: async (name, text, opts) => void calls.push(["send", name, text, opts]),
    key: async (name, key) => void calls.push(["key", name, key]),
    stop: async (name) => {
      calls.push(["stop", name]);
      sessions.delete(name);
    },
    renew: async (name) => {
      calls.push(["renew", name]);
      if (!sessions.has(name)) throw new Error("no such lab");
    },
    attach: async (name) => void calls.push(["attach", name]),
  };
  return cli;
}

export const TEAM = [
  { name: "lead", role: "builder", parent: null, model: "claude-cli/claude-sonnet-5-5", lines: ["working...", "↑6 ↓350 R31k W23k CH36.7% $0.005 9.0%/200k (auto)"] },
  { name: "scout", role: "explorer", parent: "lead", model: "claude-cli/claude-haiku-5-5" },
  { name: "review", role: "advisor", parent: "lead", model: "claude-cli/claude-opus-5-5", state: "stalled" },
];
