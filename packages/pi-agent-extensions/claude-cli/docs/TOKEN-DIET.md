# Token diet for the claude-cli provider

Every Pi turn on the `claude-cli` provider starts a fresh `claude -p` process and re-sends the conversation. This note records where the tokens went, what was changed, and the before/after numbers, with the exact method so they can be reproduced.

## Result

Same scenario, same model, same scratch repo, same end state (the edit applied, the file written, the tests passing in every run). Mean per run, tokens as reported by Claude CLI's `usage` fields:

| Setup | Runs | Tool calls | API round trips | Input | Cache write | Cache read | Output | All tokens | Fresh per tool call¹ | Cost |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Haiku 5.5, 4 tools, **before** | 3 | 9 | 30 | 45 | 71,368 | 126,434 | 2,892 | 200,739 | 8,256 | $0.0170 |
| Haiku 5.5, 4 tools, **after** | 3 | 9 | 11 | 20 | 9,929 | 40,508 | 1,605 | **52,062** (-74%) | **1,284** (-84%) | $0.0032 |
| Haiku 5.5, 18 tools, **before** | 2 | 9 | 28 | 41 | 121,842 | 216,950 | 2,966 | 341,798 | 13,872 | $0.0280 |
| Haiku 5.5, 18 tools, **after** | 2 | 9 | 12 | 20 | 14,660 | 93,168 | 1,979 | **109,827** (-68%) | **1,851** (-87%) | $0.0049 |
| Sonnet 5.5, 4 tools, **before** | 1 | 9 | 23 | 26 | 66,240 | 47,867 | 1,286 | 115,419 | 7,506 | $0.2827 |
| Sonnet 5.5, 4 tools, **after** | 1 | 9 | 11 | 20 | 11,359 | 38,829 | 732 | **50,940** (-56%) | **1,346** (-82%) | $0.0601 |

¹ input + cache write + output, divided by tool calls: the tokens that are new work on every call. Cache reads are the cheap part (a tenth of the input price).

"API round trips" is the number of requests Claude Code made inside the spawned processes (from the provider's usage log). Costs for the "after" rows are the provider's own estimate (`cost-estimate.ts`); "before" rows use Claude Code's `total_cost_usd`, so the cost columns mix two methods. The estimate was calibrated against `claude -p --output-format json` runs: Haiku 5.5 and Haiku 4.5 reproduce `total_cost_usd` exactly (0.00059289 and 0.013751 USD), Sonnet 5.5 and Opus 5.5 imply base prices of 1.98 and 3.97 per million input tokens against the 2 and 4 used (under 1% off). Claude Code bills cache writes at the 1-hour rate, so weights are input 1, cache write 2, cache read 0.1, output 5. The 4-tool set is Pi's built-ins (`read`, `bash`, `edit`, `write`); the 18-tool set adds the bundled browser/jobs/asset tools.

Per turn, Haiku, 4 tools, one run each (the first turn is the cold start; turn 10 is the final text):

| # | Tool | Before: input / cache write / cache read / output / round trips | After: input / cache write / cache read / output / round trips |
| --- | --- | --- | --- |
| 1 | bash | 4 / 6,345 / 10,983 / 212 / 3 | 2 / 2,701 / 1,661 / 58 / 1 |
| 2 | read | 8 / 6,802 / 20,580 / 391 / 4 | 2 / 656 / 3,997 / 104 / 1 |
| 3 | read | 4 / 6,879 / 11,564 / 165 / 3 | 2 / 728 / 3,997 / 122 / 1 |
| 4 | bash | 8 / 7,226 / 21,296 / 460 / 4 | 2 / 820 / 3,997 / 173 / 1 |
| 5 | bash | 4 / 7,400 / 12,064 / 212 / 3 | 2 / 1,088 / 3,997 / 103 / 1 |
| 6 | edit | 4 / 7,656 / 12,191 / 314 / 3 | 2 / 1,142 / 3,997 / 181 / 1 |
| 7 | bash | 4 / 7,692 / 12,368 / 174 / 3 | 2 / 1,251 / 3,997 / 90 / 1 |
| 8 | write | 4 / 8,078 / 12,589 / 365 / 3 | 2 / 514 / 4,883 / 342 / 1 |
| 9 | bash | 4 / 8,068 / 12,735 / 209 / 3 | 2 / 581 / 4,883 / 132 / 1 |
| 10 | (final) | 2 / 8,051 / 2,420 / 325 / 2 | 2 / 449 / 5,099 / 577 / 2 |

Before, every tool call cost 6-8k newly written tokens and three API requests. After, it costs about 0.5-1.2k and one request.

## Method (reproducible)

```sh
cd packages/pi-agent-extensions
node claude-cli/scripts/measure-tokens.mjs --label after --runs 3                  # current code, Haiku 5.5, 4 tools
node claude-cli/scripts/measure-tokens.mjs --label after-full --runs 2 --full-tools  # with the bundled tool extensions
node claude-cli/scripts/measure-tokens.mjs --model claude-sonnet-5-5 --runs 1
node claude-cli/scripts/measure-tokens.mjs --ext /path/to/old/claude-cli/index.ts --label before   # an older copy of the provider
```

`scripts/measure-tokens.mjs` creates a throwaway git repo (a README, a two-function module with a wrong operator, a main file, a test file), then runs a real `pi` process with `--mode json -p` and only the provider under test loaded (`--no-extensions -e <provider>`), thinking off. The prompt lists ten steps in order, one tool call each: `ls -la`, read README, read the module, grep for TODO, run the program, fix the bug with the edit tool, run the tests, write a notes file, `git diff --stat`, and a one-line summary with no tool call. For every Pi turn it records the `usage` that the provider reports (input, cache write, cache read, output), taken from Claude CLI's stream-json `result` event (or, for stopped runs, its `message_start`/`message_delta` events). The provider additionally appends one line per spawned `claude` process to the file named by `PI_CLAUDE_CLI_USAGE_LOG` (turn count inside the process, durations, and the sizes of what Pi sends in); the harness reads it for the round-trip column. After the run the harness checks the scratch repo (edit applied, notes written, `node --test` passing) so a cheaper run that did not do the work cannot pass for a win. The repo is deleted afterwards.

Baseline = the provider as of the commit that added the usage log and this script, before any prompt change. Run-to-run noise is small for this scenario (three "after" runs within 1% of each other; a final re-run of the finished code after the review fixes gave 51,933 tokens, 11 round trips, 9,943 / 40,625 cache write / read), but one ablation run took 11 tool calls instead of 9, so compare per tool call when the counts differ. Identical consecutive runs share a warm prompt cache for the static part of the prompt, which flatters cache reads equally before and after. Only Haiku 5.5 was repeated; Sonnet 5.5 is a single run per side.

## Where the tokens went

Measured on the old code with the usage log:

1. **Three API requests per Pi tool call.** The model called the capture MCP tool (request 1); Claude Code sent the acknowledgement back (request 2) and the model then produced the structured final output (request 3). Pi throws away everything after the first message, because it only needs the tool requests. Each request re-reads the whole context.
2. **Claude Code's default system prompt.** Native tools are disabled, so the long tool-usage and environment guidance is dead weight on every request (about 31k tokens per scenario run, see the ablation).
3. **History inside the system prompt.** The conversation was appended to the system prompt, which therefore differed on every turn, so Pi's own prompt, the bridge rules and the response policy that sit behind it were rewritten to the cache on every turn instead of read.
4. **Tool schemas sent three times:** once as the MCP tool list, once as a JSON dump in the bridge prompt (about 2.7k characters for four tools, 11k for eighteen), and once inside the structured-output schema (names only, small). Each MCP description also carried an extra sentence.
5. **Long tool call ids** (`claude_cli_mcp_<uuid>`) repeated in every history entry.

## What changed

| Change | File |
| --- | --- |
| Stop the `claude` process as soon as its first message has requested host tools. The calls are read from that message's streamed `tool_use` blocks (name plus the joined `input_json_delta` parts), not from the capture handlers, so parallel, serialised or rejected MCP calls cannot stall a turn; the handlers only wait for the decision (at most 15 s) so Claude Code never sends the acknowledgement. A message that mixes in the structured-output tool, names an inactive tool or has unreadable arguments falls back to the normal flow. One API request per tool call; the final-answer turn is unchanged. | `early-stop.ts`, `index.ts` |
| A short stub system prompt that also states today's date (Claude Code's own prompt used to supply it). | `prompt.ts` |
| The tool results of the current turn (parallel calls arrive as separate messages) are never cut and their images are all sent. | `prompt.ts`, `media.ts` |
| Replace Claude Code's default system prompt with a two-sentence stub (`--system-prompt`); Pi's prompt, the bridge rules and the response policy still go through `--append-system-prompt-file`. | `prompt.ts`, `index.ts` |
| Send the history as one text block per message in the user turn instead of inside the system prompt. | `prompt.ts`, `media.ts` |
| Tool schemas once, as the MCP list; the bridge prompt carries only compact signatures (`read(path, offset?, limit?)`) as a fallback hint; no extra sentence on each description; shorter bridge text. | `prompt.ts`, `index.ts` |
| Short stable labels (`t1`, `t2`) instead of call ids in the history. | `prompt.ts` |
| Older tool results above 12,000 characters are cut in the middle with a marker that says how much was left out and to run the tool again if needed. The newest result is never cut. (Pi's own tools already cap output at 50 KB.) | `prompt.ts` |
| A cost estimate for stopped runs, since `total_cost_usd` only arrives in the `result` event that no longer comes. Unknown models get no estimate rather than a guess. | `cost-estimate.ts` |
| `PI_CLAUDE_CLI_USAGE_LOG` (one JSON line per spawned process) and `PI_CLAUDE_CLI_ADVISOR` (opt-in, below). | `usage-log.ts`, `cli-args.ts` |

### Ablations (Haiku, 4 tools; each removes one change from the final code)

| Variant | Runs | API round trips | Cache write | Cache read | Output | All tokens | Cost |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Final | 3 | 11 | 9,929 | 40,508 | 1,605 | 52,062 | $0.0032 |
| Without early stop | 1 | 36 (11 tool calls) | 17,078 | 132,937 | 6,800 | 156,877 | $0.0082 |
| Default Claude Code system prompt | 1 | 11 | 16,922 | 64,213 | 1,906 | 83,061 | $0.0050 |
| History inside the system prompt | 2 | 11.5 | 34,142 | 19,398 | 1,513 | 55,075 | $0.0078 |

Early stop is the largest single saving (it removes two thirds of the requests and most of the output). The system-prompt stub saves about 31k tokens a run. Moving the history out of the system prompt barely changes the total token count but cuts cache-write tokens, which are billed at twice the input price, by 3.4x.

## The Sonnet-lead / Haiku-subagents / Opus-advisor tip

- `claude --help` lists `--agents <json>`, `--forward-subagent-text` and `claude agents` (background sessions). It does **not** list `--advisor` or `--subagents`. `--subagents haiku` is rejected (`unknown option '--subagents'`).
- `--advisor <model>` is accepted although hidden from the help (the binary contains an "advisor tool"). It works with a subscription login: `claude -p --model claude-sonnet-5-5 --advisor opus` runs and the request grows from about 2.7k to 4.3k input tokens on a one-word prompt, so the advisor tool definition costs roughly 1.6k tokens on every request. That is more than a third of the 4-tool "after" request, so it is **off by default**; `PI_CLAUDE_CLI_ADVISOR=opus` passes it through for people who want the second opinion more than the saving. It is a quality feature, not a token saving, and no scenario here exercised an actual consult.
- Subagents do not apply inside this provider. Pi owns tool execution and Claude's native tools (including the agent/task tool) are disabled, so there is nothing for a Haiku subagent to explore with, and a subagent definition would only add tokens. The split is useful one level up, as separate labs: see `lab-team` in `skills/lab-commander`.

## What did not help, or was not done

- **History is still rewritten each turn.** The provider is stateless: Claude Code starts without a session and Pi's full history is rebuilt into one user turn. Cache-read tokens in the "after" rows stay flat at the static prefix (about 4k) while the per-turn cache write follows the history (0.5-1.3k tokens per turn in this short scenario), so cost over a very long session still grows with its length. The structural fix is to resume a Claude Code session between Pi turns so earlier turns are cache reads. It was not attempted: stopping the process after the first message (the saving above) leaves a tool request without a result in any saved session, resuming would need a different capture design, and Pi's retries, edits and compaction rewrite history behind the provider's back.
- **Lazy tool loading** was not done. All active tools stay in the MCP list so the model can never see a different tool set than Pi allows. Eighteen tools are about 11k characters; after the first request they are cache reads.
- **Lower default effort for tool-heavy turns** was not changed. Pi's thinking setting is the user's choice, and these runs used thinking off, so the effect was not measured.
- **A persistent `claude` process per Pi session** (saving the start-up of each spawn) was not done for the same history-ownership reason.
- Truncation of older tool results does not appear in these numbers: the scenario's results are small. It matters for sessions that read large files, and is covered by unit tests.
- Costs of the "before" and "after" Sonnet rows are single runs; treat them as indicative.

## Review

An independent review (Opus, read-only, one consult) of the first version found, among others: an early stop that waited for the capture handlers could stall a turn for 15 s when Claude Code runs MCP calls one at a time, and miscounted when a call was rejected (fixed by reading the calls from the stream; a two-call prompt now completes in one turn with both calls); results of the current parallel batch were being cut as "older" and only the last message's images were sent (fixed); Claude Code's date line was lost with its default prompt (restored). Two review remarks are accepted limitations: thinking blocks and non-text roles are not replayed in the history (as before), and the cost columns mix two methods (stated above).

## Tests

`npm test` in `packages/pi-agent-extensions` covers the prompt builder (block stability, labels, truncation marker, signatures), the early-stop decision, the cost estimate, the usage log, the advisor flag and the measurement script's folding and verification. Nothing in the unit tests calls the Claude API; only the measurement script does.
