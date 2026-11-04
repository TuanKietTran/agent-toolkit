/**
 * Cost for a run that was stopped before Claude Code printed its `result` event
 * (which is where `total_cost_usd` normally comes from).
 *
 * Claude Code bills prompt-cache writes at the 1-hour rate, so the weights are:
 * input 1x, cache write 2x, cache read 0.1x, output 5x of the model's base input
 * price. Base prices (USD per million input tokens) were read back from
 * `claude -p --output-format json` runs; the formula reproduces its
 * `total_cost_usd` to within about one percent. Models not listed here have no
 * estimate, so Pi shows no cost instead of a guess.
 */
const BASE_INPUT_USD_PER_MTOK: Array<[prefix: string, price: number]> = [
  ["claude-haiku-5-5", 0.1],
  ["claude-haiku-4-5", 1],
  ["claude-sonnet-", 2],
  ["claude-opus-", 4],
];

export interface TokenCounts {
  input: number;
  cacheWrite: number;
  cacheRead: number;
  output: number;
}

export function estimateCostUsd(modelId: string, usage: TokenCounts): number | undefined {
  const entry = BASE_INPUT_USD_PER_MTOK.find(([prefix]) => modelId.startsWith(prefix));
  if (!entry) return undefined;
  const units = usage.input + usage.cacheWrite * 2 + usage.cacheRead * 0.1 + usage.output * 5;
  return (units * entry[1]) / 1_000_000;
}
