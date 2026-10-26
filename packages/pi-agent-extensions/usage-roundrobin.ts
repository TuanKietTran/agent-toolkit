// usage-roundrobin — spread work across models so no 5h usage window runs dry.
//
// The control loop is deficit-weighted round robin over the models you allow:
//
//   charge  = tokens x (model price index / cheapest price index)   "quota units"
//   spare   = 1 - (window% + observed drain velocity x minutes left) per window
//   pick    = argmin(charge so far / spare)  among eligible models
//
// Pricing is the proxy for how fast a token drains a subscription window: an
// Opus token costs ~25x a Haiku token, so it must be charged ~25x. Velocity is
// read from the same ~/.pi/usage-touchbar.json the Touch Bar strip renders, so
// the numbers here and the numbers on the strip can never disagree, and usage
// burned by *other* Claude Code / Codex clients is accounted for too.
//
// Switching model every turn would destroy the provider prompt cache and cost
// more than it saves, so a switch only happens once the current model has
// burned a quantum of quota units, or the moment its window becomes unsafe.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Model } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { PI_EVENT } from "./core/events.ts";

// --- Constants: every local literal lives here. ---

// os.homedir() prefers $HOME, which a tmux server that outlived its shell can
// leave stale. Same reasoning as touchbar-usage/src/usage.mjs.
const HOME = (() => {
  try {
    return os.userInfo().homedir || os.homedir();
  } catch {
    return os.homedir();
  }
})();

const STATE_PATH = path.join(HOME, ".pi", "usage-roundrobin.json");
const SETTINGS_PATH = path.join(HOME, ".pi", "agent", "settings.json");
const AUTO_PROVIDER = "auto-rotate";
const AUTO_MODEL = "auto-rotate";
const AUTO_NAME = "Auto Rotate";
const AUTO_BASE_URL = "http://127.0.0.1:1/v1";
const AUTO_API = "openai-completions";
const AUTO_API_KEY = "not-used";
const STATUS_KEY = "usage-roundrobin";
const STATUS_DISABLED = "RR off";
const TONE_DIM = "dim";
const TONE_WARNING = "warning";
const TONE_INFO = "info";
const TONE_ERROR = "error";
const COMMAND_NAME = "roundrobin";
const COMMAND_DESCRIPTION = "Round-robin models across 5h usage windows (status|on|off|now|models|set|reset)";
const ACTION_STATUS = "status";
const ACTION_ON = "on";
const ACTION_OFF = "off";
const ACTION_NOW = "now";
const ACTION_MODELS = "models";
const ACTION_SET = "set";
const ACTION_RESET = "reset";
const WIDGET_PLACEMENT = "aboveEditor";
const WINDOW_MS = 5 * 60 * 60 * 1000;
const PROVIDER_COOLDOWN_MS = 5 * 60 * 1000;
const MIN_VELOCITY_SAMPLE_MS = 90_000;
const VELOCITY_ALPHA = 0.35;
/** Blended agent-loop mix: most input is cache reads, output is the scarce part. */
const PRICE_MIX = { input: 0.25, cacheRead: 0.6, output: 0.15 };

const DEFAULT_CONFIG = {
  enabled: true,
  /** Quota units a model keeps before the rotation may move on. Guards the prompt cache. */
  quantumTokens: 60_000,
  /** A window at or above this fraction is treated as spent. */
  hardCap: 0.9,
  /** Dollar budget per 5h window for API-key (non-subscription) models. */
  paygBudgetUsd: 5,
  /** provider/id patterns; `*` allowed. Empty means "use scoped models, else all available models". */
  models: [] as string[],
};

type Config = typeof DEFAULT_CONFIG;

interface VelocitySample {
  percent: number;
  at: number;
  ewmaPerMin: number | null;
}

interface PersistedState {
  ledgerVersion: number;
  config: Config;
  /** Reset time the counters belong to; counters clear when it passes. */
  epoch: number | null;
  /** provider/id -> quota units charged this window. */
  charged: Record<string, number>;
  /** provider/id -> raw tokens this window, for display. */
  tokens: Record<string, number>;
  /** provider/id -> dollars this window (only meaningful for pay-as-you-go). */
  spendUsd: Record<string, number>;
  /** "claude:5h" -> last observed percent, for drain velocity. */
  samples: Record<string, VelocitySample>;
  current: string | null;
  chargedSinceSwitch: number;
}

const EMPTY_STATE: PersistedState = {
  ledgerVersion: 2,
  config: { ...DEFAULT_CONFIG },
  epoch: null,
  charged: {},
  tokens: {},
  spendUsd: {},
  samples: {},
  current: null,
  chargedSinceSwitch: 0,
};

// ------------------------------------------------------------------ storage

function readState(): PersistedState {
  try {
    const raw = JSON.parse(fs.readFileSync(STATE_PATH, "utf8")) as Partial<PersistedState>;
    const legacy = raw.ledgerVersion !== EMPTY_STATE.ledgerVersion;
    return {
      ...EMPTY_STATE,
      ...raw,
      ledgerVersion: EMPTY_STATE.ledgerVersion,
      config: { ...DEFAULT_CONFIG, ...(raw.config ?? {}) },
      charged: legacy ? {} : (raw.charged ?? {}),
      tokens: legacy ? {} : (raw.tokens ?? {}),
      spendUsd: legacy ? {} : (raw.spendUsd ?? {}),
      chargedSinceSwitch: legacy ? 0 : (raw.chargedSinceSwitch ?? 0),
      samples: raw.samples ?? {},
    };
  } catch {
    return { ...EMPTY_STATE, config: { ...DEFAULT_CONFIG } };
  }
}

/** Atomic publish so a concurrent session never reads a torn file. */
function writeState(state: PersistedState): void {
  try {
    fs.mkdirSync(path.dirname(STATE_PATH), { recursive: true });
    const tmp = `${STATE_PATH}.tmp.${process.pid}`;
    fs.writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(tmp, STATE_PATH);
  } catch {
    // Losing the ledger degrades fairness, never correctness: the next pick
    // still respects the live window percentages.
  }
}

/** Manual model picks become the next startup default; automatic RR switches do not. */
function persistDefaultModel(model: Model<any>): void {
  try {
    const settings = JSON.parse(fs.readFileSync(SETTINGS_PATH, "utf8")) as Record<string, unknown>;
    settings.defaultProvider = model.provider;
    settings.defaultModel = model.id;
    const tmp = `${SETTINGS_PATH}.tmp.${process.pid}`;
    fs.writeFileSync(tmp, `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(tmp, SETTINGS_PATH);
  } catch {
    // A read-only or malformed settings file must not prevent model selection.
  }
}

/**
 * Read-modify-write against the file rather than a cached object. Several pi
 * sessions share one set of usage windows, so their token ledgers have to
 * accumulate into the same place or each would think it owns the whole quota.
 */
function mutate(apply: (state: PersistedState) => void): PersistedState {
  const state = readState();
  apply(state);
  writeState(state);
  return state;
}

// ------------------------------------------------------------- usage source

interface PublishedWindow {
  label: string;
  percent: number;
  resetsAt: number | null;
}

interface PublishedSide {
  ok?: boolean;
  windows?: PublishedWindow[];
}

interface Published {
  updatedAt?: number;
  claude?: PublishedSide;
  codex?: PublishedSide;
}

type UsageCore = {
  refresh: (options?: { force?: boolean }) => Promise<Published | null>;
  readPublished: () => Published | null;
};

let corePromise: Promise<UsageCore | null> | undefined;

function usageCore(): Promise<UsageCore | null> {
  // Same core the Touch Bar host runs, imported lazily so a broken usagebar
  // never blocks pi from starting.
  corePromise ??= import(new URL("./touchbar-usage/src/usage.mjs", import.meta.url).href)
    .then((module) => module as unknown as UsageCore)
    .catch(() => null);
  return corePromise;
}

async function currentUsage(): Promise<Published | null> {
  const core = await usageCore();
  if (!core) return null;
  try {
    // refresh() honours usagebar's own 15s floor and cross-process lease, so
    // calling it per turn does not add network traffic.
    return (await core.refresh()) ?? core.readPublished();
  } catch {
    try {
      return core.readPublished();
    } catch {
      return null;
    }
  }
}

// -------------------------------------------------------------- model facts

type PoolId = "claude" | "codex" | "payg";

const keyOf = (model: Model<any>) => `${model.provider}/${model.id}`;

function poolOf(model: Model<any>, ctx: ExtensionContext): PoolId {
  // The Claude CLI uses a placeholder API key in Pi, but actually spends the
  // authenticated Claude Code subscription window, not a pay-as-you-go budget.
  if (model.provider === "claude-cli") return "claude";
  // For other providers, only OAuth spends a subscription window. The same
  // model behind an API key spends dollars instead.
  let oauth = false;
  try {
    oauth = ctx.modelRegistry.isUsingOAuth(model);
  } catch {
    oauth = false;
  }
  if (!oauth) return "payg";
  if (/^(anthropic|claude-cli)/.test(model.provider)) return "claude";
  if (/^openai-codex/.test(model.provider)) return "codex";
  return "payg";
}

/** Dollars per million tokens for the blended agent-loop mix. */
function priceIndex(model: Model<any>): number {
  const cost = model.cost ?? ({} as Model<any>["cost"]);
  const index =
    (cost.input ?? 0) * PRICE_MIX.input +
    (cost.cacheRead ?? 0) * PRICE_MIX.cacheRead +
    (cost.output ?? 0) * PRICE_MIX.output;
  if (index > 0) return index;
  // Claude CLI reports zero prices because Pi does not bill for its tokens.
  // Use relative Anthropic prices for quota accounting instead of treating
  // every Claude model as nearly free (which starves all other providers).
  if (model.provider === "claude-cli") {
    const tier = /haiku/i.test(model.id) ? 1 : /sonnet/i.test(model.id) ? 3 : 5;
    return tier * PRICE_MIX.input + tier * 0.1 * PRICE_MIX.cacheRead + tier * 5 * PRICE_MIX.output;
  }
  // A genuinely free local model must not divide by zero.
  return 0.01;
}

function matches(pattern: string, model: Model<any>): boolean {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  const regex = new RegExp(`^${escaped}$`);
  return regex.test(keyOf(model)) || regex.test(model.id);
}

function candidates(ctx: ExtensionContext, config: Config, unavailableProviders = new Set<string>()): Model<any>[] {
  const available = ctx.modelRegistry.getAvailable().filter((model) =>
    model.provider !== AUTO_PROVIDER && !unavailableProviders.has(model.provider),
  );
  const patterns = config.models.length
    ? config.models
    : ctx.scopedModels.length
      ? ctx.scopedModels.map((entry) => keyOf(entry.model))
      : null;
  return patterns
    ? available.filter((model) => patterns.some((pattern) => matches(pattern, model)))
    : available;
}

function supportsCurrentInput(candidate: Model<any>, current: Model<any>): boolean {
  return current.input.every((input) => candidate.input.includes(input));
}

function parseRetryAfter(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : undefined;
}

// ------------------------------------------------------------ window health

interface WindowHealth {
  label: string;
  percent: number;
  projected: number;
  velocityPerMin: number;
  minutesLeft: number;
}

/**
 * Fold a fresh percentage into an EWMA of percent-per-minute. Samples closer
 * together than MIN_VELOCITY_SAMPLE_MS are ignored: usage endpoints round to
 * whole percent, so a 20-second delta is quantisation noise amplified by a
 * tiny denominator, not a drain rate.
 */
function updateVelocity(state: PersistedState, id: string, percent: number, now: number): number {
  const previous = state.samples[id];
  if (!previous) {
    state.samples[id] = { percent, at: now, ewmaPerMin: null };
    return 0;
  }
  const elapsed = now - previous.at;
  if (elapsed < MIN_VELOCITY_SAMPLE_MS) return previous.ewmaPerMin ?? 0;

  const delta = percent - previous.percent;
  // A negative delta is a window reset, not negative consumption.
  const rate = delta < 0 ? 0 : delta / (elapsed / 60_000);
  const ewma =
    previous.ewmaPerMin === null ? rate : previous.ewmaPerMin * (1 - VELOCITY_ALPHA) + rate * VELOCITY_ALPHA;
  state.samples[id] = { percent, at: now, ewmaPerMin: ewma };
  return ewma;
}

function poolHealth(
  state: PersistedState,
  published: Published | null,
  pool: PoolId,
  now: number,
): WindowHealth[] {
  if (pool === "payg") return [];
  const side = pool === "claude" ? published?.claude : published?.codex;
  const windows = side?.windows ?? [];
  return windows.map((window) => {
    const percent = Math.max(0, Math.min(100, window.percent)) / 100;
    const minutesLeft = window.resetsAt ? Math.max(0, (window.resetsAt - now) / 60_000) : WINDOW_MS / 60_000;
    const velocityPerMin = updateVelocity(state, `${pool}:${window.label}`, window.percent, now) / 100;
    return {
      label: window.label,
      percent,
      velocityPerMin,
      minutesLeft,
      projected: Math.min(2, percent + velocityPerMin * minutesLeft),
    };
  });
}

interface Scored {
  model: Model<any>;
  pool: PoolId;
  spare: number;
  eligible: boolean;
  reason: string;
  charged: number;
  tokens: number;
  health: WindowHealth[];
}

/**
 * Spare is the fraction of the binding window predicted to be *left* at reset.
 * Taking the minimum across windows means a nearly exhausted weekly cap pushes
 * traffic away even while the 5h window still looks empty.
 */
function score(
  state: PersistedState,
  published: Published | null,
  model: Model<any>,
  ctx: ExtensionContext,
  now: number,
): Scored {
  const config = state.config;
  const pool = poolOf(model, ctx);
  const key = keyOf(model);
  const charged = state.charged[key] ?? 0;
  const tokens = state.tokens[key] ?? 0;

  if (pool === "payg") {
    const spent = state.spendUsd[key] ?? 0;
    const spare = 1 - spent / Math.max(0.01, config.paygBudgetUsd);
    return {
      model,
      pool,
      spare: Math.max(0.01, spare),
      eligible: spare > 1 - config.hardCap,
      reason: spare > 1 - config.hardCap ? "ok" : `budget $${spent.toFixed(2)}/${config.paygBudgetUsd}`,
      charged,
      tokens,
      health: [],
    };
  }

  const health = poolHealth(state, published, pool, now);
  if (!health.length) {
    // No usage data for this pool yet. Treat it as usable but unremarkable so
    // the rotation still includes it instead of silently dropping a provider.
    return { model, pool, spare: 0.5, eligible: true, reason: "no usage data", charged, tokens, health };
  }

  const binding = health.reduce((worst, window) => (window.projected > worst.projected ? window : worst));
  const spare = Math.max(0.01, 1 - binding.projected);
  const spent = health.some((window) => window.percent >= config.hardCap);
  return {
    model,
    pool,
    spare,
    eligible: !spent,
    reason: spent ? `${binding.label} ${Math.round(binding.percent * 100)}% spent` : "ok",
    charged,
    tokens,
    health,
  };
}

/** Cheapest price index decides the unit of "one quota unit". */
function cheapestIndex(models: Model<any>[]): number {
  // Free local models must not make hosted charges hundreds of times larger.
  const hosted = models.filter((model) => priceIndex(model) > 0.01);
  const pool = hosted.length ? hosted : models;
  return pool.reduce((min, model) => Math.min(min, priceIndex(model)), Number.POSITIVE_INFINITY);
}

// ---------------------------------------------------------------- selection

interface Decision {
  chosen: Scored | null;
  scored: Scored[];
  switched: boolean;
  note: string;
}

/**
 * Weighted-fair-queueing rank. The seed matters: without it every model starts
 * the window at charged=0, the ratios all tie at zero, and the winner would be
 * whichever candidate happened to be listed first — an exhausted Opus window
 * would be picked over an untouched Haiku one. Seeding with one quantum makes
 * the first allocation headroom-ordered, then real consumption takes over.
 */
function rank(entry: Scored, seed: number): number {
  return (entry.charged + seed) / entry.spare;
}

function decide(state: PersistedState, scored: Scored[], currentKey: string | null): Decision {
  if (!scored.length) return { chosen: null, scored, switched: false, note: "no candidate models" };

  let pool = scored.filter((entry) => entry.eligible);
  let note = "";
  if (!pool.length) {
    // Every window is at the cap. Refusing to answer is worse than spending
    // the least-exhausted one, so fall back rather than block the turn.
    pool = [...scored].sort((a, b) => b.spare - a.spare).slice(0, 1);
    note = "all windows near cap; using the least exhausted";
  }

  const current = pool.find((entry) => keyOf(entry.model) === currentKey);
  // Deficit round robin: least quota consumed per unit of predicted headroom.
  const seed = Math.max(1, state.config.quantumTokens);
  const best = pool.reduce((winner, entry) => (rank(entry, seed) < rank(winner, seed) ? entry : winner));

  if (current && state.chargedSinceSwitch < state.config.quantumTokens) {
    return { chosen: current, scored, switched: false, note: note || "holding quantum" };
  }
  return { chosen: best, scored, switched: keyOf(best.model) !== currentKey, note };
}

// -------------------------------------------------------------- presentation

const short = (model: Model<any>) => model.id.replace(/-2\d{7}$/, "");

function poolSummary(scored: Scored[]): string {
  const seen = new Map<PoolId, WindowHealth[]>();
  for (const entry of scored) {
    if (entry.pool !== "payg" && entry.health.length && !seen.has(entry.pool)) seen.set(entry.pool, entry.health);
  }
  const label: Record<string, string> = { claude: "CC", codex: "CX" };
  return [...seen.entries()]
    .map(([pool, health]) => {
      const windows = health.map((window) => `${window.label} ${Math.round(window.percent * 100)}%`).join("/");
      return `${label[pool] ?? pool} ${windows}`;
    })
    .join(" ");
}

function updateStatus(ctx: ExtensionContext, state: PersistedState, decision: Decision | null): void {
  if (!ctx.hasUI) return;
  if (!state.config.enabled) {
    ctx.ui.setStatus(STATUS_KEY, ctx.ui.theme.fg(TONE_DIM, STATUS_DISABLED));
    return;
  }
  const name = decision?.chosen ? short(decision.chosen.model) : "—";
  const quantum = `${Math.round(state.chargedSinceSwitch / 1000)}k/${Math.round(state.config.quantumTokens / 1000)}k`;
  const pools = decision ? poolSummary(decision.scored) : "";
  const line = `RR ${name} ${quantum}${pools ? ` ${pools}` : ""}`;
  const strained = decision?.chosen ? decision.chosen.spare < 0.15 : false;
  ctx.ui.setStatus(STATUS_KEY, ctx.ui.theme.fg(strained ? TONE_WARNING : TONE_DIM, line));
}

// ------------------------------------------------------------------ extension

export default function usageRoundRobin(pi: ExtensionAPI) {
  // A synthetic picker entry: selecting it immediately resolves to a real model,
  // so its placeholder endpoint is never used for a provider request.
  pi.registerProvider(AUTO_PROVIDER, {
    name: AUTO_NAME,
    baseUrl: AUTO_BASE_URL,
    api: AUTO_API,
    apiKey: AUTO_API_KEY,
    models: [{
      id: AUTO_MODEL,
      name: AUTO_NAME,
      reasoning: true,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 1_000_000,
      maxTokens: 128_000,
    }],
  });

  // Distinguishes our own setModel() from the user reaching for /model.
  let applying = false;
  let failingOver = false;
  let lastFailedProvider: string | undefined;
  let lastDecision: Decision | null = null;
  const unavailableUntil = new Map<string, number>();

  function unavailableProviders(now = Date.now()): Set<string> {
    const unavailable = new Set<string>();
    for (const [provider, until] of unavailableUntil) {
      if (until > now) unavailable.add(provider);
      else unavailableUntil.delete(provider);
    }
    return unavailable;
  }

  /** Clear the per-window ledgers once the window they describe has rolled over. */
  function rollWindow(state: PersistedState, published: Published | null, now: number): void {
    const resets = [published?.claude, published?.codex]
      .flatMap((side) => side?.windows ?? [])
      .map((window) => window.resetsAt)
      .filter((at): at is number => typeof at === "number" && at > now);
    const epoch = resets.length ? Math.min(...resets) : now + WINDOW_MS;

    if (state.epoch !== null && now < state.epoch) return;
    if (state.epoch !== null) {
      state.charged = {};
      state.tokens = {};
      state.spendUsd = {};
      state.chargedSinceSwitch = 0;
    }
    state.epoch = epoch;
  }

  async function reschedule(ctx: ExtensionContext, force = false, failover = false): Promise<Decision | null> {
    const config = readState().config;
    if (!config.enabled) return null;

    const published = await currentUsage();
    const now = Date.now();
    const unavailable = unavailableProviders(now);
    let models = candidates(ctx, config, unavailable);
    if (failover && ctx.model && ctx.model.provider !== AUTO_PROVIDER) {
      // A failure must not escape an explicitly selected rotation pool.
      models = models.filter((model) => supportsCurrentInput(model, ctx.model!));
    }
    if (!models.length) {
      if (ctx.hasUI && force) ctx.ui.notify("usage-roundrobin: no candidate models are available", "warning");
      return null;
    }
    let decision: Decision | null = null;
    mutate((draft) => {
      rollWindow(draft, published, now);
      const scored = models.map((model) => score(draft, published, model, ctx, now));
      decision = decide(draft, scored, draft.current ?? (ctx.model ? keyOf(ctx.model) : null));
      // Commit only after setModel succeeds; a failed switch must not hold a
      // phantom model for the next quantum.
    });

    const resolved = decision as Decision | null;
    if (resolved?.chosen && ctx.model && keyOf(resolved.chosen.model) !== keyOf(ctx.model)) {
      applying = true;
      try {
        const ok = await pi.setModel(resolved.chosen.model);
        if (!ok) {
          if (ctx.hasUI) ctx.ui.notify(`usage-roundrobin: no credentials for ${keyOf(resolved.chosen.model)}`, "warning");
          return null;
        }
        if (ctx.hasUI) ctx.ui.notify(
          `usage-roundrobin → ${short(resolved.chosen.model)} (${Math.round(resolved.chosen.spare * 100)}% window spare)`,
          "info",
        );
      } finally {
        applying = false;
      }
    }

    if (resolved?.chosen && ctx.model && keyOf(ctx.model) === keyOf(resolved.chosen.model)) {
      if (readState().current !== keyOf(resolved.chosen.model)) {
        mutate((draft) => {
          draft.current = keyOf(resolved.chosen!.model);
          draft.chargedSinceSwitch = 0;
        });
      }
    }
    lastDecision = resolved;
    updateStatus(ctx, readState(), resolved);
    return resolved;
  }

  pi.on(PI_EVENT.SESSION_START, async (_event, ctx) => {
    // Pi has already restored the session/default model at this point. Adopt it
    // as the active slot before scheduling; otherwise a stale ledger quantum can
    // immediately replace the user's last pick during /reload or a new session.
    const auto = ctx.model?.provider === AUTO_PROVIDER;
    if (ctx.model) {
      mutate((draft) => {
        draft.config.enabled = auto || draft.config.enabled;
        draft.current = auto ? null : keyOf(ctx.model!);
        draft.chargedSinceSwitch = 0;
      });
    }
    // In Auto Rotate mode, escape the configured pool if necessary rather than
    // ever allowing the synthetic picker model to reach a provider request.
    await reschedule(ctx, auto, auto);
  });

  // Decide before the run starts: this is the only point where a switch is both
  // safe (no in-flight request) and still affects the upcoming turn.
  pi.on(PI_EVENT.BEFORE_AGENT_START, async (_event, ctx) => {
    await reschedule(ctx);
  });

  pi.on(PI_EVENT.MESSAGE_END, (event, ctx) => {
    if (event.message.role !== "assistant") return;
    const usage = event.message.usage;
    if (!usage) return;

    const model = ctx.model;
    if (!model) return;
    const key = keyOf(model);
    const config = readState().config;
    const units = Math.max(1, priceIndex(model) / Math.max(0.01, cheapestIndex(candidates(ctx, config, unavailableProviders()))));
    const tokens = usage.totalTokens ?? usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
    const charge = tokens * units;

    const state = mutate((draft) => {
      draft.charged[key] = (draft.charged[key] ?? 0) + charge;
      draft.tokens[key] = (draft.tokens[key] ?? 0) + tokens;
      draft.spendUsd[key] = (draft.spendUsd[key] ?? 0) + (usage.cost?.total ?? 0);
      if (draft.current === key) draft.chargedSinceSwitch += charge;
    });
    updateStatus(ctx, state, lastDecision);
  });

  // The model picker doubles as the mode picker. "Auto Rotate" enables managed
  // selection; choosing any real model disables it and leaves that model fixed.
  // Internal rotation/failover keeps `applying` set and cannot alter the mode/default.
  pi.on(PI_EVENT.MODEL_SELECT, async (event, ctx) => {
    if (applying || event.source === "restore") return;
    const auto = event.model.provider === AUTO_PROVIDER && event.model.id === AUTO_MODEL;
    persistDefaultModel(event.model);
    const state = mutate((draft) => {
      draft.config.enabled = auto;
      draft.current = auto ? null : keyOf(event.model);
      draft.chargedSinceSwitch = 0;
    });
    updateStatus(ctx, state, lastDecision);

    if (auto) {
      const decision = await reschedule(ctx, true, true);
      if (!decision?.chosen && event.previousModel?.provider !== AUTO_PROVIDER) {
        applying = true;
        try {
          if (event.previousModel) await pi.setModel(event.previousModel);
        } finally {
          applying = false;
        }
      }
      if (ctx.hasUI) ctx.ui.notify("Auto Rotate enabled", decision?.chosen ? "info" : "warning");
    } else if (ctx.hasUI) {
      ctx.ui.notify(`Auto Rotate disabled; fixed on ${keyOf(event.model)}`, "info");
    }
  });

  async function failOver(provider: string, ctx: ExtensionContext, retryAfterMs?: number): Promise<void> {
    if (!readState().config.enabled || failingOver || applying) return;
    failingOver = true;
    try {
      unavailableUntil.set(provider, Date.now() + Math.max(PROVIDER_COOLDOWN_MS, retryAfterMs ?? 0));
      const before = ctx.model ? keyOf(ctx.model) : undefined;
      await reschedule(ctx, true, true);
      const after = ctx.model ? keyOf(ctx.model) : undefined;
      if (after && after !== before) {
        lastFailedProvider = provider;
        if (ctx.hasUI) ctx.ui.notify(`Provider ${provider} hit its limit; retrying with ${after}.`, "warning");
      } else if (ctx.hasUI) {
        ctx.ui.notify(`Provider ${provider} hit its limit, but no compatible fallback provider is available.`, "error");
      }
    } finally {
      failingOver = false;
    }
  }

  pi.on(PI_EVENT.AFTER_PROVIDER_RESPONSE, async (event, ctx) => {
    if (event.status !== 429 || !ctx.model) return;
    await failOver(ctx.model.provider, ctx, parseRetryAfter(event.headers["retry-after"]));
  });

  pi.on(PI_EVENT.MESSAGE_END, async (event, ctx) => {
    const message = event.message;
    if (message.role !== "assistant" || message.stopReason !== "error") return;
    const error = message.errorMessage ?? "";
    if (!/(?:rate|usage|quota)\s*(?:limit|exceeded)|too many requests|insufficient_quota|resource exhausted|http\s*429/i.test(error)) return;
    const provider = message.provider || ctx.model?.provider;
    if (!provider || provider === lastFailedProvider) {
      lastFailedProvider = undefined;
      return;
    }
    await failOver(provider, ctx);
  });

  pi.registerCommand(COMMAND_NAME, {
    description: COMMAND_DESCRIPTION,
    handler: async (args, ctx) => {
      const [action = ACTION_STATUS, ...rest] = args.trim().split(/\s+/).filter(Boolean);

      if (action === ACTION_ON || action === ACTION_OFF) {
        const enabled = action === ACTION_ON;
        mutate((draft) => {
          draft.config.enabled = enabled;
        });
        if (enabled) await reschedule(ctx, true);
        else ctx.ui.setStatus(STATUS_KEY, ctx.ui.theme.fg(TONE_DIM, STATUS_DISABLED));
        ctx.ui.notify(`${STATUS_KEY} ${enabled ? "enabled" : "disabled"}`, TONE_INFO);
        return;
      }

      if (action === ACTION_RESET) {
        mutate((draft) => {
          draft.charged = {};
          draft.tokens = {};
          draft.spendUsd = {};
          draft.samples = {};
          draft.chargedSinceSwitch = 0;
          draft.epoch = null;
        });
        ctx.ui.notify("usage-roundrobin ledger cleared", "info");
        await reschedule(ctx, true);
        return;
      }

      if (action === ACTION_MODELS) {
        mutate((draft) => {
          draft.config.models = rest;
        });
        ctx.ui.notify(
          rest.length ? `Rotation set to: ${rest.join(", ")}` : "Rotation follows scoped models",
          "info",
        );
        await reschedule(ctx, true);
        return;
      }

      if (action === ACTION_SET) {
        const [field, raw] = rest;
        const value = Number(raw);
        const allowed = ["quantumTokens", "hardCap", "paygBudgetUsd"] as const;
        if (!allowed.includes(field as (typeof allowed)[number]) || !Number.isFinite(value)) {
          ctx.ui.notify(`Usage: /roundrobin set <${allowed.join("|")}> <number>`, "warning");
          return;
        }
        mutate((draft) => {
          (draft.config as Record<string, unknown>)[field] = value;
        });
        ctx.ui.notify(`${field} = ${value}`, "info");
        return;
      }

      if (action !== ACTION_STATUS && action !== ACTION_NOW) {
        ctx.ui.notify("Usage: /roundrobin [status|on|off|now|models <patterns>|set <key> <n>|reset]", "warning");
        return;
      }

      const decision = await reschedule(ctx, true);
      const state = readState();
      if (!decision) {
        ctx.ui.notify(
          state.config.enabled ? "No usage data or candidate models yet" : "usage-roundrobin is off",
          "warning",
        );
        return;
      }

      const seed = Math.max(1, state.config.quantumTokens);
      const rows = [...decision.scored]
        .sort((a, b) => rank(a, seed) - rank(b, seed))
        .map((entry) => {
          const marker = decision.chosen && keyOf(entry.model) === keyOf(decision.chosen.model) ? "▶" : " ";
          const windows = entry.health.length
            ? entry.health
                .map(
                  (window) =>
                    `${window.label} ${Math.round(window.percent * 100)}%→${Math.round(window.projected * 100)}%`,
                )
                .join(" ")
            : entry.pool === "payg"
              ? `$${(state.spendUsd[keyOf(entry.model)] ?? 0).toFixed(2)}/${state.config.paygBudgetUsd}`
              : "—";
          return `${marker} ${short(entry.model).padEnd(22)} ${entry.pool.padEnd(6)} spare ${(entry.spare * 100)
            .toFixed(0)
            .padStart(3)}%  ${Math.round(entry.tokens / 1000)}k tok  ${windows}${
            entry.eligible ? "" : `  [${entry.reason}]`
          }`;
        });

      ctx.ui.setWidget(
        STATUS_KEY,
        [
          `quantum ${Math.round(state.chargedSinceSwitch / 1000)}k/${Math.round(state.config.quantumTokens / 1000)}k · cap ${Math.round(state.config.hardCap * 100)}%`,
          ...rows,
          decision.note ? `note: ${decision.note}` : `ledger: ${STATE_PATH}`,
        ],
        { placement: WIDGET_PLACEMENT },
      );
    },
  });
}
