import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

const loaderPath = "./pi-root.mjs";
const { createLoader } = await import(loaderPath);
const loader = await createLoader(import.meta.url);
const {
  compactionCandidates,
  compactionModels,
  recordCompactionFailure,
  resetCompactionFailures,
}: typeof import("../guards/context-optimize.ts") = await loader.import("../guards/context-optimize.ts");

interface FakeModel {
  provider: string;
  id: string;
  cost?: { input: number; output: number };
  contextWindow?: number;
  maxTokens?: number;
}

const model = (provider: string, id: string, extra: Partial<FakeModel> = {}): FakeModel => ({
  provider,
  id,
  contextWindow: 200000,
  maxTokens: 8192,
  ...extra,
});
const priced = (provider: string, id: string, input: number, output: number = input): FakeModel =>
  model(provider, id, { cost: { input, output } });

type Options = Parameters<typeof compactionModels>[1];
type AuthCheck = (model: FakeModel) => boolean;

const ctxFor = (available: FakeModel[], hasConfiguredAuth?: AuthCheck): ExtensionContext => ({
  modelRegistry: {
    getAvailable: () => available,
    ...(hasConfiguredAuth ? { hasConfiguredAuth } : {}),
  },
} as unknown as ExtensionContext);

const keys = (models: readonly { provider: string; id: string }[]): string[] =>
  models.map((entry) => `${entry.provider}/${entry.id}`);
const select = (available: FakeModel[], options: Options = {}, hasConfiguredAuth?: AuthCheck): string[] =>
  keys(compactionModels(ctxFor(available, hasConfiguredAuth), { settings: {}, ...options }));
const candidates = (available: FakeModel[], options: Options = {}, hasConfiguredAuth?: AuthCheck) =>
  compactionCandidates(ctxFor(available, hasConfiguredAuth), { settings: {}, ...options });

test("candidates are ranked cheapest first; unpriced models rank last", () => {
  resetCompactionFailures();
  assert.deepEqual(select([
    priced("p-expensive", "e", 10),
    model("p-unpriced", "u"),
    priced("p-mid", "m", 5),
    priced("p-cheap", "c", 1),
  ]), ["p-cheap/c", "p-mid/m", "p-expensive/e", "p-unpriced/u"]);
});

test("equal cost ties break toward the larger context window", () => {
  resetCompactionFailures();
  assert.deepEqual(select([
    model("aaa", "small-window", { cost: { input: 5, output: 5 }, contextWindow: 100000 }),
    model("zzz", "big-window", { cost: { input: 5, output: 5 }, contextWindow: 300000 }),
  ]), ["zzz/big-window", "aaa/small-window"]);
});

test("no available providers selects nothing", () => {
  resetCompactionFailures();
  assert.deepEqual(select([]), []);
  assert.deepEqual(candidates([]), []);
});

test("a cheaper model without configured auth falls through to the next candidate", () => {
  resetCompactionFailures();
  const available = [priced("noauth", "cheap", 1), priced("authed", "next", 2)];
  const auth: AuthCheck = (entry) => entry.provider !== "noauth";
  assert.deepEqual(select(available, {}, auth), ["authed/next"]);
  const rejected = candidates(available, {}, auth).find((candidate) => candidate.model.provider === "noauth");
  assert.match(rejected?.reason ?? "", /no configured auth/);
});

test("a model that recently failed compaction is skipped until the cooldown expires", () => {
  resetCompactionFailures();
  const cheap = priced("fail-cheap", "c", 1);
  const next = priced("fail-next", "n", 2);
  recordCompactionFailure(cheap, "429 quota", 1000);
  assert.deepEqual(select([next, cheap], { now: 2000 }), ["fail-next/n"]);
  assert.deepEqual(select([next, cheap], { now: 1000 + 300001 }), ["fail-cheap/c", "fail-next/n"]);
  resetCompactionFailures();
});

test("a model whose context window cannot fit the transcript plus headroom is rejected", () => {
  resetCompactionFailures();
  const small = model("small", "s", { contextWindow: 52000 });
  const big = model("big", "b");
  assert.deepEqual(select([small, big], { inputTokens: 50000 }), ["big/b"]);
  const rejected = candidates([small, big], { inputTokens: 50000 }).find((candidate) => candidate.model.provider === "small");
  assert.match(rejected?.reason ?? "", /insufficient headroom/);
});

test("settings compaction.model pins selection; maxCostRank caps it", () => {
  resetCompactionFailures();
  const available = [priced("p-cheap", "c", 1), priced("p-mid", "m", 5), priced("p-expensive", "e", 10)];
  assert.deepEqual(select(available, { settings: { model: "p-mid/m" } }), ["p-mid/m"]);
  assert.deepEqual(select(available, { settings: { model: "m" } }), ["p-mid/m"]);
  assert.deepEqual(select(available, { settings: { maxCostRank: 2 } }), ["p-cheap/c", "p-mid/m"]);
  const capped = candidates(available, { settings: { maxCostRank: 2 } }).find((candidate) => candidate.model.provider === "p-expensive");
  assert.match(capped?.reason ?? "", /maxCostRank/);
});

test("duplicate registry entries are deduplicated", () => {
  resetCompactionFailures();
  const dup = priced("dup", "d", 1);
  assert.deepEqual(select([dup, dup]), ["dup/d"]);
  const ranked = candidates([dup, dup]);
  assert.equal(ranked.length, 2);
  assert.match(ranked[1]?.reason ?? "", /duplicate/);
});
