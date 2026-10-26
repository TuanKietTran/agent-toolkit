// touchbar-usage core — standalone ESM, zero deps.
//
// Deliberately NOT a pi module: the Touch Bar host (BetterTouchTool / MTMR)
// runs this file directly on its own timer, so the strip keeps updating
// whether or not pi is running. The pi extension imports the same file.
//
// Publishes:
//   ~/.pi/usage-touchbar.json  structured state
//   ~/.pi/usage-touchbar.txt   one render-ready line
//
// Multi-process safe: N pi sessions across tmux panes / Ghostty windows all
// call refresh(); exactly one does the network work per interval, the rest
// read the published file.

import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// os.homedir() PREFERS $HOME on POSIX and only falls back to the passwd
// entry, so it inherits a stale $HOME from a tmux/zellij server that outlived
// its spawning shell. os.userInfo().homedir goes straight to getpwuid and
// ignores the environment, which is the property we actually want here.
function resolveHome() {
  try {
    const home = os.userInfo().homedir;
    if (home) return home;
  } catch {}
  return os.homedir();
}

const HOME = resolveHome();

export const STATE_DIR = path.join(HOME, ".pi");
export const JSON_PATH = path.join(STATE_DIR, "usage-touchbar.json");
export const TEXT_PATH = path.join(STATE_DIR, "usage-touchbar.txt");
const LEASE_DIR = path.join(STATE_DIR, "usage-touchbar.lease");

const MIN_INTERVAL_MS = 15_000;   // freshness floor: never hit the APIs faster
const LEASE_TTL_MS = 90_000;      // lease older than this is presumed abandoned
const LEASE_WAIT_MS = 3_000;      // cold start: wait for the lease winner to publish
const LEASE_POLL_MS = 100;
const STALE_MS = 15 * 60_000;     // past this the line is marked with `!`
const FETCH_TIMEOUT_MS = 8_000;
const KEYCHAIN_TIMEOUT_MS = 5_000;

// Verified live 2026-09-07. The Codex one is /wham/usage, NOT /codex/usage —
// the latter exists but serves an HTML error page.
const CLAUDE_USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
const CODEX_USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";

const UA = "pi-touchbar-usage/1.0";

// ---------------------------------------------------------------- utilities

const nowMs = () => Date.now();
const ensureStateDir = () => fs.mkdirSync(STATE_DIR, { recursive: true });

/** Atomic publish: same-dir temp + rename(). A reader never sees a torn file. */
function writeAtomic(target, contents) {
  ensureStateDir();
  const tmp = `${target}.tmp.${process.pid}.${Math.random().toString(36).slice(2, 8)}`;
  try {
    fs.writeFileSync(tmp, contents, { mode: 0o600 });
    fs.renameSync(tmp, target);
  } catch (err) {
    try { fs.unlinkSync(tmp); } catch {}
    throw err;
  }
}

function readJsonFile(file) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return null; }
}

function num(v) {
  const n = typeof v === "string" ? Number(v) : v;
  return typeof n === "number" && Number.isFinite(n) ? n : null;
}

const clampPct = (p) => Math.max(0, Math.min(999, Math.round(p)));

function execFileCapped(cmd, args, timeoutMs) {
  return new Promise((resolve) => {
    execFile(
      cmd,
      args,
      // SIGKILL, not SIGTERM: `security` prompting against a locked keychain
      // (common over ssh) ignores TERM and would hang the poll forever.
      { timeout: timeoutMs, killSignal: "SIGKILL", encoding: "utf8" },
      (err, stdout) => resolve(err ? null : String(stdout).trim()),
    );
  });
}

// ------------------------------------------------------------------- lease
//
// mkdir is atomic on APFS, so it doubles as a cross-process mutex without
// relying on flock semantics that vary by filesystem.

function leaseOwnerAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0); // signal 0 = liveness probe, delivers nothing
    return true;
  } catch (err) {
    return err && err.code === "EPERM"; // exists, just not ours
  }
}

function acquireLease() {
  ensureStateDir();
  try {
    fs.mkdirSync(LEASE_DIR);
  } catch (err) {
    if (err.code !== "EEXIST") return false;

    // Someone holds it. Evict only if demonstrably gone: a tmux pane killed
    // mid-fetch (SIGKILL, no cleanup) must not wedge every other session
    // until the TTL expires.
    let stat = null;
    try { stat = fs.statSync(LEASE_DIR); } catch { return false; }
    const owner = readJsonFile(path.join(LEASE_DIR, "owner.json"));
    const expired = nowMs() - stat.mtimeMs > LEASE_TTL_MS;
    const dead = !owner || !leaseOwnerAlive(owner.pid);
    if (!expired && !dead) return false;

    try {
      fs.rmSync(LEASE_DIR, { recursive: true, force: true });
      fs.mkdirSync(LEASE_DIR);
    } catch {
      return false; // lost the race to another reclaimer — fine, it will poll
    }
  }
  try {
    fs.writeFileSync(
      path.join(LEASE_DIR, "owner.json"),
      JSON.stringify({ pid: process.pid, at: nowMs() }),
    );
  } catch {}
  return true;
}

function releaseLease() {
  try { fs.rmSync(LEASE_DIR, { recursive: true, force: true }); } catch {}
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Cold start only: we lost the lease race and have nothing cached to show.
 * Returning null here would make every other tmux pane — and, worse, the
 * Touch Bar host itself — print an em-dash while the winner is mid-fetch.
 * Wait briefly for the winner to publish instead of rendering a false empty.
 */
async function awaitFirstPublish() {
  const deadline = nowMs() + LEASE_WAIT_MS;
  while (nowMs() < deadline) {
    await sleep(LEASE_POLL_MS);
    const published = readPublished();
    if (published) return published;
    // Winner died before publishing; stop waiting on a lease nobody holds.
    if (!fs.existsSync(LEASE_DIR)) return readPublished();
  }
  return readPublished();
}

// ------------------------------------------------------------------ parsing

/** ISO string, epoch seconds, or epoch ms -> epoch ms. */
function toEpochMs(v) {
  if (typeof v === "string") {
    const t = Date.parse(v);
    return Number.isNaN(t) ? null : t;
  }
  const n = num(v);
  if (n === null || n <= 0) return null;
  return n > 1e12 ? n : n * 1000; // seconds vs ms
}

/**
 * Name a window by how long it actually is rather than assuming 5h/7d.
 * Codex free plans report a single 30-day window; labelling that "5h" would
 * be a straightforwardly wrong number on the strip.
 */
export function windowLabel(seconds) {
  const s = num(seconds);
  if (s === null || s <= 0) return null;
  if (s < 3600) return `${Math.max(1, Math.round(s / 60))}m`;
  const hours = s / 3600;
  if (hours < 24) return `${Math.round(hours)}h`;
  const days = Math.round(s / 86400);
  if (days === 7) return "wk";
  if (days >= 28 && days <= 31) return "mo";
  return `${days}d`;
}

// -------------------------------------------------------------- claude side
//
// Live shape (2026-09-07):
//   { five_hour: { utilization: 73.0, resets_at: "<iso>" },
//     seven_day: { utilization: 6.0, resets_at: "<iso>" },
//     extra_usage: { is_enabled: false, used_credits: null, ... },
//     spend: { used: { amount_minor, currency, exponent }, enabled: false },
//     limits: [ { kind: "session", percent, resets_at }, ... ] }

function claudeWindow(node, label) {
  if (!node || typeof node !== "object") return null;
  let pct = num(node.utilization);
  if (pct === null) {
    // Fallback for the dollar-denominated variant some tiers report.
    const used = num(node.used_dollars);
    const limit = num(node.limit_dollars);
    if (used !== null && limit !== null && limit > 0) pct = (used / limit) * 100;
  }
  if (pct === null) return null;
  return { label, percent: clampPct(pct), resetsAt: toEpochMs(node.resets_at) };
}

/** Fallback path: the flat `limits` array, used if the named keys ever move. */
function claudeWindowsFromLimits(payload) {
  const out = [];
  const limits = Array.isArray(payload?.limits) ? payload.limits : [];
  for (const item of limits) {
    const pct = num(item?.percent);
    if (pct === null) continue;
    const kind = String(item?.kind ?? item?.group ?? "");
    const label = /session|hour|5h/i.test(kind) ? "5h"
      : /week|7d/i.test(kind) ? "wk"
      : /month|30d/i.test(kind) ? "mo"
      : null;
    if (label) out.push({ label, percent: clampPct(pct), resetsAt: toEpochMs(item?.resets_at) });
  }
  return out;
}

/**
 * Extra-usage credits. Per the ask these render ONLY when the account
 * actually has extra usage turned on — otherwise a permanent "$0.00" eats
 * scarce Touch Bar width for nothing.
 */
function claudeCredits(payload) {
  const extra = payload?.extra_usage ?? {};
  const spend = payload?.spend ?? {};
  const enabled = extra.is_enabled === true || spend.enabled === true;
  if (!enabled) return null;

  // Prefer the minor-unit spend figure; it carries its own exponent.
  const minor = num(spend?.used?.amount_minor);
  const exponent = num(spend?.used?.exponent);
  let usd = minor !== null ? minor / 10 ** (exponent ?? 2) : num(extra.used_credits);
  if (usd === null) {
    const util = num(extra.utilization);
    if (util === null) return null;
    return { enabled: true, percent: clampPct(util <= 1 ? util * 100 : util) };
  }
  return { enabled: true, usd, currency: spend?.used?.currency ?? extra.currency ?? "USD" };
}

async function claudeToken() {
  const raw = await execFileCapped(
    "security",
    ["find-generic-password", "-s", "Claude Code-credentials", "-w"],
    KEYCHAIN_TIMEOUT_MS,
  );
  let blob = null;
  if (raw) { try { blob = JSON.parse(raw); } catch {} }
  // Some installs keep this on disk instead of the keychain.
  if (!blob) blob = readJsonFile(path.join(HOME, ".claude", ".credentials.json"));
  const oauth = blob?.claudeAiOauth ?? blob?.claude_ai_oauth ?? blob;
  const token = oauth?.accessToken ?? oauth?.access_token;
  if (!token) return null;
  const expires = num(oauth?.expiresAt ?? oauth?.expires_at);
  // Refreshing is Claude Code's job, not ours — don't race it for the token.
  if (expires !== null && expires > 0 && expires < nowMs()) return null;
  return token;
}

async function fetchClaude() {
  const token = await claudeToken();
  if (!token) return { ok: false, error: "no-auth" };
  try {
    const payload = await fetchJson(CLAUDE_USAGE_URL, {
      authorization: `Bearer ${token}`,
      "anthropic-beta": "oauth-2025-04-20",
      accept: "application/json",
      "user-agent": UA,
    });
    let windows = [
      claudeWindow(payload.five_hour, "5h"),
      claudeWindow(payload.seven_day, "wk"),
    ].filter(Boolean);
    if (!windows.length) windows = claudeWindowsFromLimits(payload);
    if (!windows.length) return { ok: false, error: "shape" };
    return {
      ok: true,
      account: payload?.email ?? payload?.account?.email_address ?? null,
      windows,
      credits: claudeCredits(payload),
      at: nowMs(),
    };
  } catch (err) {
    return { ok: false, error: shortError(err) };
  }
}

// --------------------------------------------------------------- codex side
//
// Live shape (2026-09-07):
//   { plan_type: "free",
//     rate_limit: { primary_window:   { used_percent, limit_window_seconds,
//                                       reset_after_seconds, reset_at },
//                   secondary_window: null },
//     credits: { has_credits, balance, unlimited, ... } }

function codexWindow(node, fallbackLabel) {
  if (!node || typeof node !== "object") return null;
  const pct = num(node.used_percent ?? node.usedPercent);
  if (pct === null) return null;
  const label = windowLabel(node.limit_window_seconds ?? node.limitWindowSeconds) ?? fallbackLabel;
  const resetsAt =
    toEpochMs(node.reset_at ?? node.resetAt) ??
    (num(node.reset_after_seconds) !== null
      ? nowMs() + num(node.reset_after_seconds) * 1000
      : null);
  return { label, percent: clampPct(pct), resetsAt };
}

function codexCredits(payload) {
  const c = payload?.credits;
  if (!c || typeof c !== "object") return null;
  if (c.unlimited === true) return { enabled: true, unlimited: true };
  // has_credits false means the balance is not part of this account's plan;
  // same rule as Claude — don't spend strip width on a disabled feature.
  if (c.has_credits !== true) return null;
  const balance = num(c.balance);
  return balance === null ? null : { enabled: true, usd: balance };
}

function codexAuth() {
  // Match the account used by pi, rather than an unrelated Codex CLI login.
  const piAuth = readJsonFile(path.join(HOME, ".pi", "agent", "auth.json"))?.["openai-codex"];
  if (piAuth?.type === "oauth" && piAuth.access) {
    return { token: piAuth.access, accountId: piAuth.accountId ?? null };
  }
  const blob = readJsonFile(path.join(HOME, ".codex", "auth.json"));
  const tokens = blob?.tokens ?? blob;
  const token = tokens?.access_token ?? tokens?.accessToken;
  if (!token) return null;
  return { token, accountId: tokens?.account_id ?? tokens?.accountId ?? null };
}

async function fetchCodex() {
  const auth = codexAuth();
  if (!auth) return { ok: false, error: "no-auth" };
  try {
    const headers = {
      authorization: `Bearer ${auth.token}`,
      accept: "application/json",
      "user-agent": UA,
    };
    if (auth.accountId) headers["chatgpt-account-id"] = auth.accountId;
    const payload = await fetchJson(CODEX_USAGE_URL, headers);
    const rl = payload?.rate_limit ?? payload?.rateLimit ?? {};
    const windows = [
      codexWindow(rl.primary_window ?? rl.primaryWindow, "5h"),
      codexWindow(rl.secondary_window ?? rl.secondaryWindow, "wk"),
    ].filter(Boolean);
    if (!windows.length) return { ok: false, error: "shape" };
    return {
      ok: true,
      plan: payload?.plan_type ?? null,
      account: payload?.email ?? payload?.account_id ?? null,
      windows,
      credits: codexCredits(payload),
      at: nowMs(),
    };
  } catch (err) {
    return { ok: false, error: shortError(err) };
  }
}

// ------------------------------------------------------------------ network

/**
 * Set PI_USAGEBAR_TRACE=<file> to append one line per outbound request.
 * This is the only way to *prove* the singleton property rather than assume
 * it: run N processes, then count the lines.
 */
function trace(url) {
  const file = process.env.PI_USAGEBAR_TRACE;
  if (!file) return;
  try {
    fs.appendFileSync(file, `${new Date().toISOString()} pid=${process.pid} ${url}\n`);
  } catch {}
}

async function fetchJson(url, headers) {
  trace(url);
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const body = await res.text();
  // chatgpt.com answers unknown backend paths with a 200 HTML holding page,
  // so a JSON.parse failure here means "wrong endpoint", not "bad data".
  try { return JSON.parse(body); } catch { throw new Error("non-json"); }
}

function shortError(err) {
  const msg = String(err?.message ?? err);
  if (/timed?.?out|abort/i.test(msg)) return "timeout";
  if (/HTTP 401|HTTP 403/.test(msg)) return "auth";
  if (/HTTP 429/.test(msg)) return "429";
  if (/non-json/.test(msg)) return "shape";
  if (/ENOTFOUND|EAI_AGAIN|ECONNREFUSED|fetch failed|network/i.test(msg)) return "offline";
  const http = msg.match(/HTTP \d{3}/);
  return http ? http[0].replace("HTTP ", "") : "error";
}

// ------------------------------------------------------------------- render

function fmtReset(resetsAt) {
  if (!resetsAt) return "";
  const ms = resetsAt - nowMs();
  if (ms <= 0) return "";
  const mins = Math.round(ms / 60_000);
  if (mins < 60) return `⟳${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) {
    const m = mins % 60;
    return m ? `⟳${hours}h${String(m).padStart(2, "0")}m` : `⟳${hours}h`;
  }
  return `⟳${Math.round(hours / 24)}d`;
}

function renderCredits(credits) {
  if (!credits?.enabled) return null;
  if (credits.unlimited) return "$∞";
  if (typeof credits.usd === "number") return `$${credits.usd.toFixed(2)}`;
  if (typeof credits.percent === "number") return `$${credits.percent}%`;
  return null;
}

function renderSide(label, side) {
  if (!side) return `${label} —`;
  if (!side.ok) {
    // A transient blip should not wipe numbers that are still roughly true.
    if (side.windows?.length) return renderSide(label, { ...side, ok: true });
    return `${label} ${side.error === "no-auth" ? "—" : `!${side.error}`}`;
  }
  const parts = [label];
  for (const w of side.windows ?? []) parts.push(`${w.label} ${w.percent}%`);
  const credits = renderCredits(side.credits);
  if (credits) parts.push(credits);
  // Only the soonest reset is worth the width.
  const soonest = (side.windows ?? [])
    .map((w) => w.resetsAt)
    .filter((t) => typeof t === "number" && t > nowMs())
    .sort((a, b) => a - b)[0];
  const reset = fmtReset(soonest);
  if (reset) parts.push(reset);
  return parts.join(" ");
}

export function render(state) {
  const line = `${renderSide("CC", state?.claude)}  ·  ${renderSide("CX", state?.codex)}`;
  // After a laptop sleep the timers fire late; mark it so yesterday's
  // percentages are never mistaken for live ones.
  const age = state?.updatedAt ? nowMs() - state.updatedAt : Infinity;
  return age > STALE_MS ? `${line} !` : line;
}

// ------------------------------------------------------------------- public

export function readPublished() { return readJsonFile(JSON_PATH); }

/**
 * Merge a fresh side over the previous one, keeping last-good values when the
 * new fetch failed. One endpoint being down must not blank the other.
 */
function mergeSide(prev, next) {
  if (next?.ok) return next;
  if (!prev) return next;
  return { ...prev, ok: false, error: next?.error ?? "error", staleSince: prev.at ?? null };
}

/**
 * Refresh if due, otherwise return what is already published.
 * Safe to call from every pi session simultaneously.
 */
export async function refresh({ force = false } = {}) {
  const prev = readPublished();
  const age = prev?.updatedAt ? nowMs() - prev.updatedAt : Infinity;
  if (!force && age < MIN_INTERVAL_MS) return prev;

  // Another pane is fetching right now. Its result lands in the published
  // file, so a cached value can be returned immediately without blocking.
  if (!acquireLease()) return prev ?? (await awaitFirstPublish());

  try {
    const [claude, codex] = await Promise.all([fetchClaude(), fetchCodex()]);
    const state = {
      updatedAt: nowMs(),
      claude: mergeSide(prev?.claude, claude),
      codex: mergeSide(prev?.codex, codex),
    };
    state.line = render(state);
    writeAtomic(JSON_PATH, `${JSON.stringify(state, null, 2)}\n`);
    writeAtomic(TEXT_PATH, `${state.line}\n`);
    return state;
  } finally {
    releaseLease();
  }
}

/** Entry point for `bin/pi-usagebar` — prints exactly one line. */
export async function main(argv = process.argv.slice(2)) {
  const force = argv.includes("--force");
  try {
    const state = await refresh({ force });
    if (argv.includes("--json")) {
      process.stdout.write(`${JSON.stringify(state ?? {}, null, 2)}\n`);
      return;
    }
    process.stdout.write(`${state ? render(state) : "CC —  ·  CX —"}\n`);
  } catch {
    const prev = readPublished();
    process.stdout.write(`${prev ? render(prev) : "CC —  ·  CX —"}\n`);
  }
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  await main();
}
