import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

const loaderPath = "./pi-root.mjs";
const { createLoader } = await import(loaderPath);
const loader = await createLoader(import.meta.url);
const { compactionModels }: typeof import("../guards/context-optimize.ts") = await loader.import("../guards/context-optimize.ts");
const model = (provider: string, id: string) => ({ provider, id });
const select = (available: ReturnType<typeof model>[]) => compactionModels({
  modelRegistry: { getAvailable: () => available },
} as unknown as ExtensionContext).map(({ provider, id }) => `${provider}/${id}`);

test("Codex compaction prefers cheap Luna over Sol and unsupported GPT-5.5", () => {
  assert.deepEqual(select([
    model("openai-codex", "gpt-5.5"),
    model("openai-codex", "gpt-6.1-sol"),
    model("openai-codex", "gpt-5.6-luna"),
  ]), ["openai-codex/gpt-5.6-luna"]);
});

test("Codex compaction falls back to Sol when Luna is unavailable", () => {
  assert.deepEqual(select([
    model("openai-codex", "gpt-5.5"),
    model("openai", "gpt-5.5"),
    model("openai-codex", "gpt-6.1-sol"),
  ]), ["openai-codex/gpt-6.1-sol"]);
});

test("GPT-5.5 remains usable through the API provider, never through Codex", () => {
  assert.deepEqual(select([model("openai-codex", "gpt-5.5")]), []);
  assert.deepEqual(select([
    model("openai-codex", "gpt-5.5"), model("openai", "gpt-5.5"),
  ]), ["openai/gpt-5.5"]);
});

test("Haiku and local rotation tiers remain available and deduplicated", () => {
  assert.deepEqual(select([
    model("anthropic", "claude-haiku-4-5-20251001"),
    model("claude-cli", "claude-haiku-4-5-20251001"),
    model("openai-codex", "gpt-6.1-sol"),
    model("llamacpp", "local-model"),
  ]), ["claude-cli/claude-haiku-4-5-20251001", "openai-codex/gpt-6.1-sol", "llamacpp/local-model"]);
});
