// Lab Deck front end. Plain ES modules, no dependencies. All text from labs is written with
// text nodes only (no HTML sinks), so a lab cannot inject markup into the page.
const TOKEN = document.querySelector('meta[name="lab-gui-token"]')?.content ?? "";
const SVG_NS = "http://www.w3.org/2000/svg";
const $ = (id) => document.getElementById(id);

const NODE_W = 196, NODE_H = 64, GAP_X = 52, ROW_H = 84, PAD = 14;
const GLYPH = { builder: "B", explorer: "E", advisor: "A", commander: "C", manager: "M", worker: "W", lab: "L" };
const STATE_GLYPH = { working: "●", up: "●", asking: "◆", stalled: "◌", gone: "✕", planned: "○" };

const state = { snap: null, selected: null, filter: "", screenTimer: 0, lastStates: new Map(), draftFor: null, connected: false };

// ---------- helpers ----------
function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === false || v == null) continue;
    if (k === "class") el.className = v;
    else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? "" : v);
  }
  for (const kid of kids.flat()) if (kid != null) el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  return el;
}
function s(tag, attrs = {}, ...kids) {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) if (v != null && v !== false) el.setAttribute(k, v);
  for (const kid of kids.flat()) if (kid != null) el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  return el;
}
const fmtDuration = (ms) => {
  if (ms == null) return "–";
  const sec = Math.round(ms / 1000);
  if (sec < 60) return `${sec}s`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m ${sec % 60}s`;
  return `${Math.floor(sec / 3600)}h ${Math.floor((sec % 3600) / 60)}m`;
};
const fmtTokens = (n) => (n == null ? "–" : n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(n >= 1e4 ? 0 : 1)}k` : String(Math.round(n)));
const fmtCost = (n) => (n == null ? "–" : n < 0.01 ? `$${n.toFixed(4)}` : `$${n.toFixed(2)}`);
const shorten = (text, max) => (text && text.length > max ? `${text.slice(0, max - 1)}…` : text ?? "");
const stateLabel = (st) => (st === "up" ? "working" : st);
const graphspecOfLab = (lab) => (lab && typeof lab.graphspec === "object" && lab.graphspec ? lab.graphspec : null);
function resolvedModelLabel(lab) {
  const gs = graphspecOfLab(lab);
  return (gs && (gs.model_label || gs.modelLabel)) || lab.modelLabel || (gs && gs.model) || lab.model || "–";
}
function pickTag(lab) {
  const gs = graphspecOfLab(lab);
  const pick = gs && typeof gs.pick === "object" && gs.pick ? gs.pick : null;
  if (!pick || !pick.via) return "";
  const via = String(pick.via).toLowerCase().replace(/_/g, "-");
  if (via === "pinned") return "pinned";
  if (via === "fallback") return "fallback";
  if (via === "system-one" || via === "systemone" || via === "s1") return pick.rule ? `s1 ${pick.rule}` : "s1";
  return pick.rule ? `${pick.via} ${pick.rule}` : String(pick.via);
}

function sparkPoints(samples, w, hgt) {
  const n = samples.length;
  if (n < 2) return `0,${hgt - 1} ${w},${hgt - 1}`;
  const peak = Math.max(1, ...samples);
  return samples.map((v, i) => `${((i / (n - 1)) * w).toFixed(1)},${(hgt - 2 - (v / peak) * (hgt - 4)).toFixed(1)}`).join(" ");
}

async function api(path, body) {
  const res = await fetch(path, body === undefined ? {} : { method: "POST", headers: { "content-type": "application/json", "x-lab-gui-token": TOKEN }, body: JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `request failed (${res.status})`);
  return data;
}

// ---------- theme ----------
// Same idea as Omarchy: a theme is a palette (themes/<name>/colors.toml); picking one rewrites the
// page's CSS variables in one go. "System", "Default dark" and "Default light" are built in.
import { themeVars } from "/theme.js";

const BUILT_IN = [
  { name: "system", title: "System", mode: "follows OS", colors: null },
  { name: "default-dark", title: "Default dark", mode: "dark", colors: null },
  { name: "default-light", title: "Default light", mode: "light", colors: null },
];
const themeState = { all: BUILT_IN, current: "system" };

function clearThemeVars() {
  const root = document.documentElement;
  for (let i = root.style.length - 1; i >= 0; i--) {
    const prop = root.style[i];
    if (prop.startsWith("--")) root.style.removeProperty(prop);
  }
}

function applyTheme(name, remember = false) {
  const theme = themeState.all.find((t) => t.name === name) ?? BUILT_IN[0];
  clearThemeVars();
  if (theme.colors) {
    const vars = themeVars(theme.colors);
    for (const [k, v] of Object.entries(vars)) document.documentElement.style.setProperty(k, v);
    document.documentElement.dataset.theme = theme.mode === "light" ? "light" : "dark";
  } else if (theme.name === "default-dark") document.documentElement.dataset.theme = "dark";
  else if (theme.name === "default-light") document.documentElement.dataset.theme = "light";
  else delete document.documentElement.dataset.theme;
  themeState.current = theme.name;
  if (remember) {
    try {
      localStorage.setItem("lab-gui-theme", theme.name);
      localStorage.setItem("lab-gui-theme-colors", theme.colors ? JSON.stringify({ mode: theme.mode, colors: theme.colors }) : "");
    } catch { /* storage may be blocked */ }
  }
}

// First paint: reuse the saved palette before the theme list has been fetched.
try {
  const saved = localStorage.getItem("lab-gui-theme") ?? "system";
  const cached = localStorage.getItem("lab-gui-theme-colors");
  if (cached) themeState.all = [...BUILT_IN, { name: saved, title: saved, mode: JSON.parse(cached).mode, colors: JSON.parse(cached).colors }];
  applyTheme(saved);
} catch { /* ignore */ }

async function loadThemeList() {
  try {
    const { themes } = await api("/api/themes");
    themeState.all = [...BUILT_IN, ...themes];
    applyTheme(themeState.current, false); // pick up edits to the palette on disk
  } catch { /* built-ins still work */ }
}

function swatches(theme) {
  const c = theme.colors;
  const strip = h("span", { class: "chips-strip", "aria-hidden": "true" });
  const list = c ? [c.background, c.accent, c.red, c.green, c.yellow, c.cyan, c.magenta] : theme.name === "default-light" ? ["#f4f6f8", "#0b5fd6", "#c4212f", "#1a7f37", "#8a5a00", "#00717f", "#5f3bc4"] : ["#0e1116", "#2f81f7", "#f85149", "#3fb950", "#e3b341", "#4dd0e1", "#b79cff"];
  for (const color of list) { const i = h("i"); i.style.background = color; strip.append(i); }
  return strip;
}

let pickerBase = "system";
let pickerActive = "system";
function paintPicker() {
  const ul = $("theme-list");
  ul.replaceChildren(...themeState.all.map((t) => h("li", { role: "option", id: `theme-${t.name}`, "data-name": t.name, "aria-selected": String(t.name === pickerActive), onclick: () => { pickerActive = t.name; applyTheme(t.name, true); pickerBase = t.name; $("themes").close(); } },
    swatches(t), h("span", { class: "t-name" }, t.title), h("span", { class: "t-mode" }, t.mode), t.name === pickerBase ? h("span", { class: "t-now" }, "current") : null)));
  ul.setAttribute("aria-activedescendant", `theme-${pickerActive}`);
  ul.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: "nearest" });
}
function movePicker(delta, absolute) {
  const names = themeState.all.map((t) => t.name);
  let i = absolute !== undefined ? absolute : names.indexOf(pickerActive) + delta;
  i = Math.max(0, Math.min(names.length - 1, i));
  pickerActive = names[i];
  applyTheme(pickerActive); // live preview, not remembered until Enter
  paintPicker();
}
function openPicker() {
  pickerBase = themeState.current;
  pickerActive = themeState.current;
  paintPicker();
  $("themes").showModal();
  $("theme-list").focus();
}
$("theme").addEventListener("click", openPicker);
$("th-cancel").addEventListener("click", () => $("themes").close());
$("theme-list").addEventListener("keydown", (e) => {
  if (e.key === "ArrowDown") { e.preventDefault(); movePicker(1); }
  else if (e.key === "ArrowUp") { e.preventDefault(); movePicker(-1); }
  else if (e.key === "Home") { e.preventDefault(); movePicker(0, 0); }
  else if (e.key === "End") { e.preventDefault(); movePicker(0, themeState.all.length - 1); }
  else if (e.key === "Enter") { e.preventDefault(); applyTheme(pickerActive, true); pickerBase = pickerActive; $("themes").close(); }
  else if (e.key.length === 1 && /\S/.test(e.key)) {
    const hit = themeState.all.findIndex((t, idx) => idx > themeState.all.findIndex((x) => x.name === pickerActive) && t.title.toLowerCase().startsWith(e.key.toLowerCase()));
    const first = themeState.all.findIndex((t) => t.title.toLowerCase().startsWith(e.key.toLowerCase()));
    if (hit >= 0 || first >= 0) movePicker(0, hit >= 0 ? hit : first);
  }
});
// Esc, or any other way of closing without choosing, goes back to the theme that was current.
$("themes").addEventListener("close", () => { if (themeState.current !== pickerBase) applyTheme(pickerBase); });
function nextTheme() {
  const names = themeState.all.map((t) => t.name);
  const next = names[(names.indexOf(themeState.current) + 1) % names.length];
  applyTheme(next, true);
  announce(`Theme ${themeState.all.find((t) => t.name === next)?.title}`);
}

// ---------- layout ----------
function layoutForest(labs) {
  const byName = new Map(labs.map((l) => [l.name, l]));
  // A parent cycle (a lab opened under its own descendant) has no root: break it at its first member.
  const reachable = new Set();
  const mark = (lab) => { if (reachable.has(lab.name)) return; reachable.add(lab.name); labs.filter((c) => c.parent === lab.name).forEach(mark); };
  labs.filter((l) => !l.parent || !byName.has(l.parent)).forEach(mark);
  const orphans = labs.filter((l) => !reachable.has(l.name));
  for (const lab of orphans) { if (!reachable.has(lab.name)) { lab.parent = null; mark(lab); } }
  const roots = labs.filter((l) => !l.parent || !byName.has(l.parent));
  const order = [];
  let row = 0;
  const place = (lab, depth) => {
    const kids = labs.filter((c) => c.parent === lab.name);
    let y;
    if (kids.length === 0) y = row++;
    else {
      const ys = kids.map((k) => place(k, depth + 1));
      y = (ys[0] + ys[ys.length - 1]) / 2;
    }
    order.push({ lab, depth, y });
    return y;
  };
  roots.forEach((r) => place(r, 0));
  const pos = new Map(order.map((o) => [o.lab.name, { x: PAD + o.depth * (NODE_W + GAP_X), y: PAD + o.y * ROW_H, depth: o.depth }]));
  const flat = [];
  const walk = (lab, depth) => {
    flat.push({ lab, depth });
    labs.filter((c) => c.parent === lab.name).forEach((c) => walk(c, depth + 1));
  };
  roots.forEach((r) => walk(r, 0));
  return { pos, flat, width: PAD * 2 + (Math.max(0, ...order.map((o) => o.depth)) + 1) * (NODE_W + GAP_X) - GAP_X, height: PAD * 2 + Math.max(1, row) * ROW_H - (ROW_H - NODE_H) };
}

function shapeFor(kind) {
  const w = NODE_W, hh = NODE_H;
  switch (kind) {
    case "explorer": return s("rect", { class: "shape", width: w, height: hh, rx: hh / 2 });
    case "advisor": { const c = 14; return s("polygon", { class: "shape", points: `${c},0 ${w - c},0 ${w},${c} ${w},${hh - c} ${w - c},${hh} ${c},${hh} 0,${hh - c} 0,${c}` }); }
    case "commander": { const c = 18; return s("polygon", { class: "shape", points: `${c},0 ${w - c},0 ${w},${hh / 2} ${w - c},${hh} ${c},${hh} 0,${hh / 2}` }); }
    case "manager": return s("rect", { class: "shape", width: w, height: hh, rx: 3 });
    case "worker": return s("rect", { class: "shape", width: w, height: hh, rx: 9 });
    case "builder": return s("rect", { class: "shape", width: w, height: hh, rx: 14 });
    default: return s("rect", { class: "shape", width: w, height: hh, rx: 9 });
  }
}

function nodeLabel(lab) {
  const usage = lab.usage ? `, cost ${fmtCost(lab.usage.costUsd)}` : "";
  const tag = pickTag(lab);
  return `${lab.name}, ${lab.kind}, ${stateLabel(lab.state)}, model ${resolvedModelLabel(lab)}${tag ? `, pick ${tag}` : ""}${usage}`;
}

function buildNode(lab, p) {
  const g = s("g", { class: `node kind-${lab.kind} state-${lab.state}`, transform: `translate(${p.x},${p.y})`, role: "button", tabindex: "0", "data-name": lab.name, "aria-label": nodeLabel(lab) });
  g.append(
    shapeFor(lab.kind),
    s("circle", { class: "badge", cx: 26, cy: 22, r: 12 }),
    s("text", { class: "badge-t", x: 26, y: 26 }, GLYPH[lab.kind] ?? "L"),
    s("text", { class: "t-name", x: 46, y: 25 }, shorten(lab.name, 17)),
    s("text", { class: "t-sub t-model", x: 46, y: 41 }, `${lab.kind} · ${shorten(resolvedModelLabel(lab), 16)}`),
    s("text", { class: "t-tag", x: NODE_W - 8, y: 25, "text-anchor": "end" }, pickTag(lab)),
    s("circle", { class: "dot", cx: 20, cy: 50, r: 4 }),
    s("text", { class: "t-sub t-state", x: 30, y: 54 }, `${STATE_GLYPH[lab.state] ?? "●"} ${stateLabel(lab.state)}`),
    s("polyline", { class: "spark-line", points: sparkPoints(lab.samples, 52, 12), transform: `translate(${NODE_W - 64},${NODE_H - 18})` }),
  );
  g.addEventListener("click", () => select(lab.name, true));
  g.addEventListener("keydown", onNodeKey);
  return g;
}

let lastTopology = "";
function renderGraph(snap) {
  const labs = snap.labs;
  const { pos, width, height } = layoutForest(labs);
  const topology = JSON.stringify({ labs: labs.map((l) => [l.name, l.parent, l.kind, l.state, graphspecOfLab(l) ? [graphspecOfLab(l).model, graphspecOfLab(l).model_label, pickTag(l)] : null]), memberEdges: snap.memberEdges ?? snap.edges ?? [], teams: snap.teams ?? [] });
  const host = $("graph");
  if (topology !== lastTopology) {
    lastTopology = topology;
    const svg = s("svg", { width, height, viewBox: `0 0 ${width} ${height}`, role: "group", "aria-label": "Lab graph" });
    const edges = s("g", { class: "edges" });
    svg.append(edges);
    for (const lab of labs) {
      if (!lab.parent || !pos.has(lab.parent)) continue;
      const a = pos.get(lab.parent), b = pos.get(lab.name);
      const x1 = a.x + NODE_W, y1 = a.y + NODE_H / 2, x2 = b.x, y2 = b.y + NODE_H / 2, mx = (x1 + x2) / 2;
      edges.append(s("path", { class: "edge", "data-child": lab.name, d: `M${x1},${y1} C${mx},${y1} ${mx},${y2} ${x2},${y2}` }));
    }
    for (const e of snap.memberEdges ?? snap.edges ?? []) {
      const from = e.from ?? e.source, to = e.to ?? e.target;
      if (!from || !to || !pos.has(from) || !pos.has(to)) continue;
      if (labs.find((l) => l.name === to)?.parent === from) continue;
      const a = pos.get(from), b = pos.get(to);
      const x1 = a.x + NODE_W, y1 = a.y + NODE_H / 2, x2 = b.x, y2 = b.y + NODE_H / 2, mx = (x1 + x2) / 2;
      edges.append(s("path", { class: "edge member", "data-from": from, "data-to": to, d: `M${x1},${y1} C${mx},${y1} ${mx},${y2} ${x2},${y2}` }));
    }
    for (const lab of labs) svg.append(buildNode(lab, pos.get(lab.name)));
    host.replaceChildren(svg);
  }
  // In place updates: keeps keyboard focus and avoids flicker.
  for (const lab of labs) {
    const g = host.querySelector(`.node[data-name="${CSS.escape(lab.name)}"]`);
    if (!g) continue;
    g.setAttribute("class", `node kind-${lab.kind} state-${lab.state}${state.selected === lab.name ? " selected" : ""}${matches(lab) ? "" : " dim"}`);
    g.setAttribute("aria-label", nodeLabel(lab));
    g.setAttribute("aria-pressed", String(state.selected === lab.name));
    g.querySelector(".t-state").textContent = `${STATE_GLYPH[lab.state] ?? "●"} ${stateLabel(lab.state)}`;
    g.querySelector(".t-model").textContent = `${lab.kind} · ${shorten(resolvedModelLabel(lab), 16)}`;
    const tagEl = g.querySelector(".t-tag");
    if (tagEl) tagEl.textContent = pickTag(lab);
    g.querySelector(".spark-line").setAttribute("points", sparkPoints(lab.samples, 52, 12));
    const edge = host.querySelector(`.edge[data-child="${CSS.escape(lab.name)}"]`);
    if (edge) edge.setAttribute("class", `edge${lab.state === "working" ? " live" : ""}`);
  }
}

function renderList(snap) {
  const { flat } = layoutForest(snap.labs);
  const ul = $("list");
  ul.replaceChildren(
    ...flat.map(({ lab, depth }) =>
      indent(h("li", {}, 
        h("button", { type: "button", class: `card kind-${lab.kind} state-${lab.state}${state.selected === lab.name ? " selected" : ""}${matches(lab) ? "" : " dim"}`, "data-name": lab.name, "aria-label": nodeLabel(lab), "aria-pressed": String(state.selected === lab.name), onclick: () => select(lab.name, true) },
          h("span", { class: "c-name" }, lab.name),
          h("span", { class: "c-state" }, `${STATE_GLYPH[lab.state] ?? "●"} ${stateLabel(lab.state)}`),
          h("span", { class: "c-sub" }, `${lab.kind} · ${resolvedModelLabel(lab)}${pickTag(lab) ? ` · ${pickTag(lab)}` : ""}${lab.usage?.costUsd != null ? ` · ${fmtCost(lab.usage.costUsd)}` : ""}`))), depth)),
  );
}

/** Inline style attributes are blocked by the page's CSP; setting a property through the CSSOM is not. */
function indent(el, depth) {
  el.style.marginLeft = `${Math.min(depth, 4) * 14}px`;
  return el;
}

function matches(lab) {
  const q = state.filter.trim().toLowerCase();
  if (!q) return true;
  return [lab.name, lab.kind, lab.state, lab.model ?? "", resolvedModelLabel(lab), lab.parent ?? "", graphspecOfLab(lab)?.team ?? "", graphspecOfLab(lab)?.harness ?? ""].some((t) => t.toLowerCase().includes(q));
}

function renderSummary(snap) {
  const t = snap.totals;
  const chip = (cls, ...kids) => h("span", { class: `chip ${cls}` }, ...kids);
  const count = (st, glyph, n, word, extra = "") => chip(`state-${st} ${extra}`, h("span", { class: "glyph", "aria-hidden": "true" }, glyph), h("b", {}, n), ` ${word}`);
  const parts = [chip("", "labs ", h("b", {}, t.total)), count("working", "●", t.working, "working")];
  if (t.asking) parts.push(count("asking", "◆", t.asking, "asking", "warn"));
  if (t.stalled) parts.push(count("stalled", "◌", t.stalled, "stalled"));
  if (t.gone) parts.push(count("gone", "✕", t.gone, "gone", "bad"));
  if (t.tokens > 0) parts.push(chip("", "tokens ", h("b", {}, fmtTokens(t.tokens)), " · ", h("b", {}, fmtCost(t.costUsd))));
  const plannedCount = snap.planned?.length ?? snap.labs.filter((l) => l.state === "planned").length;
  if (plannedCount) parts.push(count("planned", "○", plannedCount, "planned"));
  for (const team of snap.teams ?? []) parts.push(chip("team", `${team.team}${team.run ? ` · ${team.run}` : ""} `, h("b", {}, `${team.up}/${team.total}`), " up"));
  if (!state.connected) parts.push(chip("bad", "reconnecting…"));
  $("summary").replaceChildren(...parts.flatMap((p) => [p, " "]));
}

// ---------- panel ----------
function renderPanel() {
  const lab = state.snap?.labs.find((l) => l.name === state.selected);
  const panel = $("panel");
  document.querySelector(".layout").classList.toggle("has-panel", Boolean(lab));
  panel.hidden = !lab;
  if (!lab) return;
  $("p-name").textContent = lab.name;
  const sub = $("p-sub");
  sub.replaceChildren(h("span", { class: `pill kind-${lab.kind}` }, lab.kind), " ", h("span", { class: `pill pill-state state-${lab.state}` }, `${STATE_GLYPH[lab.state] ?? "●"} ${stateLabel(lab.state)}`));
  const u = lab.usage;
  const gs = graphspecOfLab(lab);
  const rows = [
    ["Model", resolvedModelLabel(lab)],
    ...(gs ? [["Pick", pickTag(lab) || "–"], ["Team", `${gs.team ?? "–"}${gs.run ? ` · ${gs.run}` : ""}`], ["Harness", gs.harness ?? "–"], ...(gs.requested_model && gs.requested_model !== gs.model ? [["Requested", gs.requested_model]] : []), ...(gs.tools?.length ? [["Tools", gs.tools.join(", ")]] : [])] : []),
    ["Parent", lab.parent ?? "–"],
    ["Helpers", lab.children.length ? lab.children.join(", ") : "–"],
    ["Directory", lab.cwd ? (lab.cwd.length > 42 ? `…${lab.cwd.slice(-41)}` : lab.cwd) : "–"],
    ["Up", fmtDuration(lab.uptimeMs)],
    ["Quiet", fmtDuration(lab.quietMs)],
    ["Tokens", u ? `${fmtTokens(u.input)} in · ${fmtTokens(u.output)} out · ${fmtTokens(u.cacheRead)} cache read · ${fmtTokens(u.cacheWrite)} written` : "not reported by this lab"],
    ["Cost", u?.costUsd != null ? `${fmtCost(u.costUsd)}${u.cacheHitPct != null ? ` · cache hit ${u.cacheHitPct}%` : ""}` : "–"],
    ["Context", u?.contextPct != null ? `${u.contextPct}% of ${u.contextWindow ? fmtTokens(u.contextWindow) : "the"} context window` : "–"],
  ];
  $("p-meta").replaceChildren(...rows.flatMap(([k, v]) => [h("dt", {}, k), h("dd", {}, v)]));
  const spark = $("p-spark");
  spark.replaceChildren(s("polyline", { class: `spark-line state-${lab.state === "gone" ? "gone" : "working"}`, points: sparkPoints(lab.samples, 240, 36) }));
  const ended = lab.state === "gone" || lab.state === "planned";
  $("p-form").querySelectorAll("button, textarea").forEach((el) => { el.disabled = ended; });
  if (lab.state === "planned") $("p-screen").textContent = "(planned in the graphspec manifest; not started yet)";
  else if (ended) $("p-screen").textContent = "(this lab has ended; its screen is no longer available)";
}

async function pollScreen() {
  clearTimeout(state.screenTimer);
  const name = state.selected;
  if (!name) return;
  const pre = $("p-screen");
  if (state.snap?.labs.find((l) => l.name === name)?.state === "gone") return;
  try {
    if (!document.hidden) {
      const data = await api(`/api/labs/${encodeURIComponent(name)}/screen?tail=60`);
      if (state.selected !== name) return;
      const stick = pre.scrollHeight - pre.scrollTop - pre.clientHeight < 40;
      pre.textContent = data.lines.join("\n").replace(/\s+$/, "");
      if (stick) pre.scrollTop = pre.scrollHeight;
    }
  } catch (error) {
    if (state.selected === name) pre.textContent = `(cannot read the screen: ${error.message})`;
  }
  if (state.selected === name) state.screenTimer = setTimeout(pollScreen, 1000);
}

function select(name, focusPanel = false) {
  state.selected = name;
  try { history.replaceState(null, "", name ? `#lab=${encodeURIComponent(name)}` : location.pathname); } catch { /* ignore */ }
  if (state.snap) renderAll();
  $("p-screen").textContent = "";
  if (name) {
    pollScreen();
    if (focusPanel && matchMedia("(min-width: 901px)").matches) { /* keep focus on the node for arrow keys */ }
  } else clearTimeout(state.screenTimer);
}

function setNote(text, isErr = false) {
  const el = $("p-msg");
  el.textContent = text;
  el.classList.toggle("err", isErr);
}

async function sendMessage() {
  const box = $("p-text");
  const text = box.value;
  if (!text.trim() || !state.selected) return;
  setNote("Sending…");
  $("p-form").querySelector(".primary").disabled = true;
  try {
    await api(`/api/labs/${encodeURIComponent(state.selected)}/send`, { text, enter: true });
    box.value = "";
    setNote(`Sent to ${state.selected}.`);
  } catch (error) {
    setNote(error.message, true);
  } finally {
    $("p-form").querySelector(".primary").disabled = false;
  }
}

$("p-form").addEventListener("submit", (e) => { e.preventDefault(); sendMessage(); });
$("p-text").addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); sendMessage(); }
});
$("p-form").querySelectorAll("[data-key]").forEach((b) =>
  b.addEventListener("click", async () => {
    try { await api(`/api/labs/${encodeURIComponent(state.selected)}/key`, { key: b.dataset.key }); setNote(`Pressed ${b.dataset.key}.`); } catch (error) { setNote(error.message, true); }
  }));
$("p-attach").addEventListener("click", async () => {
  try { await api(`/api/labs/${encodeURIComponent(state.selected)}/attach`, {}); setNote("Opening a terminal window…"); } catch (error) { setNote(error.message, true); }
});
$("p-close").addEventListener("click", () => { const n = state.selected; select(null); focusNode(n); });

$("p-stop").addEventListener("click", () => {
  const name = state.selected;
  if (!name) return;
  $("c-body").textContent = `This ends ${name} and everything running inside it. Labs started from it are not stopped. This cannot be undone.`;
  $("c-title").textContent = `Stop ${name}?`;
  $("confirm").showModal();
});
$("confirm").addEventListener("close", async () => {
  const dlg = $("confirm");
  if (dlg.returnValue !== "stop" || !state.selected) return;
  const name = state.selected;
  try {
    await api(`/api/labs/${encodeURIComponent(name)}/stop`, { confirm: name });
    setNote(`${name} stopped.`);
    announce(`${name} stopped`);
    tickNow();
  } catch (error) {
    setNote(error.message, true);
  }
  dlg.returnValue = "";
});

// ---------- keyboard ----------
function focusNode(name) {
  if (!name) return;
  const el = document.querySelector(`.node[data-name="${CSS.escape(name)}"], .card[data-name="${CSS.escape(name)}"]`);
  const visible = [...document.querySelectorAll(`.node[data-name="${CSS.escape(name)}"], .card[data-name="${CSS.escape(name)}"]`)].find((n) => n.getClientRects().length || n instanceof SVGElement);
  (visible ?? el)?.focus();
}
function onNodeKey(e) {
  const name = e.currentTarget.dataset.name;
  if (e.key === "Enter" || e.key === " ") { e.preventDefault(); select(name, true); return; }
  const arrows = ["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"];
  if (!arrows.includes(e.key) || !state.snap) return;
  e.preventDefault();
  const { pos } = layoutForest(state.snap.labs);
  const here = pos.get(name);
  let best = null, bestScore = Infinity;
  for (const [other, p] of pos) {
    if (other === name) continue;
    const dx = p.x - here.x, dy = p.y - here.y;
    const ok = (e.key === "ArrowRight" && dx > 0) || (e.key === "ArrowLeft" && dx < 0) || (e.key === "ArrowDown" && dy > 0 && dx === 0) || (e.key === "ArrowUp" && dy < 0 && dx === 0);
    if (!ok) continue;
    const score = e.key.endsWith("Right") || e.key.endsWith("Left") ? Math.abs(dx) * 10 + Math.abs(dy) : Math.abs(dy) * 10 + Math.abs(dx);
    if (score < bestScore) { bestScore = score; best = other; }
  }
  if (best) focusNode(best);
}
document.addEventListener("keydown", (e) => {
  const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName ?? "");
  if (e.key === "Escape" && !document.querySelector("dialog[open]")) {
    if (typing && document.activeElement.id === "filter") { document.activeElement.blur(); return; }
    if (state.selected) { const n = state.selected; select(null); focusNode(n); }
    return;
  }
  if (typing || e.ctrlKey || e.metaKey || e.altKey) return;
  if (e.key === "/") { e.preventDefault(); $("filter").focus(); }
  else if (e.key === "t") $("theme").click();
  else if (e.key === "T") nextTheme();
  else if (e.key === "?") $("shortcuts").showModal();
  else if (e.key === "m" && state.selected) { e.preventDefault(); $("p-text").focus(); }
});
$("help").addEventListener("click", () => $("shortcuts").showModal());
$("filter").addEventListener("input", (e) => { state.filter = e.target.value; if (state.snap) renderAll(); });

// ---------- data ----------
function announce(text) { $("announce").textContent = text; }

function renderAll() {
  const snap = state.snap;
  if (!snap) return;
  if (state.selected && !snap.labs.some((l) => l.name === state.selected)) { state.selected = null; clearTimeout(state.screenTimer); }
  const active = document.activeElement?.closest?.("[data-name]")?.dataset.name;
  $("empty").hidden = snap.labs.length > 0;
  $("problem").hidden = !snap.error;
  if (snap.error) $("problem").textContent = `Cannot read labs: ${snap.error}`;
  renderSummary(snap);
  renderGraph(snap);
  renderList(snap);
  renderPanel();
  if (active && document.activeElement === document.body) focusNode(active);
}

function onSnapshot(snap) {
  for (const lab of snap.labs) {
    const before = state.lastStates.get(lab.name);
    if (before && before !== lab.state && ["asking", "stalled", "gone"].includes(lab.state)) announce(`${lab.name} is now ${lab.state}`);
    state.lastStates.set(lab.name, lab.state);
  }
  for (const name of [...state.lastStates.keys()]) if (!snap.labs.some((l) => l.name === name)) state.lastStates.delete(name);
  state.snap = snap;
  renderAll();
}

async function tickNow() {
  try { onSnapshot(await api("/api/labs")); state.connected = true; } catch { state.connected = false; }
}

function connect() {
  let source;
  try { source = new EventSource("/api/stream"); } catch { source = null; }
  if (!source) { setInterval(tickNow, 2000); return; }
  source.addEventListener("snapshot", (e) => { state.connected = true; onSnapshot(JSON.parse(e.data)); });
  source.onerror = () => { state.connected = false; if (state.snap) renderSummary(state.snap); };
}

loadThemeList();
const initial = decodeURIComponent((location.hash.match(/lab=([^&]+)/) ?? [])[1] ?? "");
if (initial) state.selected = initial;
tickNow().then(() => { if (state.selected) pollScreen(); connect(); });
