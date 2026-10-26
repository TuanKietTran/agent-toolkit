---
name: orchestrator-options
description: >
  Run a task as the orchestrator, autonomously. The orchestrator owns every
  question: workers', System 1's and its own are answered by the orchestrator,
  never passed back to the user. For a decision with several defensible
  approaches it reasons at xhigh effort like a chief of staff briefing a manager
  (3-4 genuinely different options with cost, risk, reversibility, a
  recommendation, its assumptions and a rule for choosing) and sends that
  briefing to System 1 through the bundled client; for a model choice it asks
  System One's `pick`. Use when the user says "System 1", "orchestrator",
  "options" or "autonomous", when a task is an orchestrated multi-agent run, or
  when a task has more than one defensible approach and nobody will answer
  questions. Do not use it for small reversible choices: just decide those.
---

# Orchestrator options (System 1, autonomous)

System 1 acts on whatever it is told and runs unattended. A vague instruction
becomes expensive work, and a question has nobody to answer it. So the input
is a **decision with options**, framed the way executives get them: what each
option costs, how fast it pays off, what could go wrong, whether it can be
undone, and what the briefer would pick. System 1 then chooses and runs.

## The orchestrator owns every question

The orchestrator is the place questions stop. A worker that asks something,
ends a turn on a question, or reports an ambiguity is asking the orchestrator,
and the user is not the fallback. Never call `AskUserQuestion`, never relay a
worker's question to the user, never end a turn on a question, before the
briefing, during the run or after it.

**Decide it.** For any ambiguity or ordinary question, choose from the task,
the repo, the specs and the briefing's selection guidance. Prefer the smaller,
more reversible reading when unsure; being slightly wrong and moving beats
stopping. Answer the worker in one short, definite message that ends with the
next step. Record each decision and its reason in a log (`DECISION: ...`) and,
in a briefing, as an `assumption`.

**Hold, do not decide, and do not ask.** Some things are not the orchestrator's
to give, and an assumption cannot stand in for them: permission or approval of a
tool call or access, consent and grants, allow/deny, credentials, logins and
accounts, anything that publishes, pushes, deploys or spends money, anything
that widens a worker beyond its scope. For these: do not answer, do not ask the
user mid-run, record `BLOCKED: <what is needed and why>`, tell the worker to
route around it and continue with other work, and put it once in the final
report so the user can act on it afterwards. (Example from a real run: this
skill's own private repo answered 404 because the CLI token was invalid. The
orchestrator did not guess its contents; it went on with the work that did not
need it and read it once the user had signed in.)

Tell every worker up front: *never end a turn on a question; record
ASSUMPTION / UNVERIFIED / BLOCKED and carry on.* A stall is silence (an idle
prompt, no output), not a matching phrase: watch for it and continue the worker
yourself.

Why this replaced `orchestrator-questions`: that skill interviewed the user
with `AskUserQuestion` before delegating. In practice the orchestrator became a
relay between the user and the workers, and every worker question became a
round trip to a person who was not there. It was removed; do not bring the
interview back.

## Hard rules

- **System 1 never decides permissions.** System One (the local decision model)
  accepts one decision kind, `model_pick`, and refuses everything else
  (`decision_kind_refused`). Never route approval, consent, allow/deny, grants
  or confirmations through it or through a briefing, and never answer a
  permission prompt for anyone. The client enforces this: a briefing whose
  decision or option titles are about permissions is refused before sending.
- No secrets in briefings, contexts or logs.

## Which path

| The decision is... | Do |
|---|---|
| a small, reversible choice | Just decide it and move on. No briefing. |
| which model to run something on | `system1_client.py pick ...` (local System One, milliseconds, nothing leaves the machine). Its answer is a recommendation; a model the user pinned wins. |
| a strategic choice with several defensible approaches, real cost or hard to undo | The options briefing below. |

## Flow for an options briefing

1. **Frame the task** in one sentence from the conversation and repo. If the
   background is long, write it to a file and pass `--context notes.md`. The
   context goes to a cloud model: task facts only, never transcripts or secrets.
2. **Run the client** (use `python` or `py -3` on Windows, where `python3` is
   often only the Store stub; use the absolute path to the client). It generates
   the briefing with Claude Opus 5.5 at `effort: xhigh` and adaptive thinking,
   then posts it to System 1:

   ```bash
   python /path/to/orchestrator-options/client/system1_client.py options "<task>" [--context notes.md]
   ```

   `--json` prints `{briefing, system1_response, error}` for programmatic use;
   `--no-send` generates without posting; `--dry-run` prints the payload.
3. **No API key or SDK?** The client exits with code 2 and says so. Do not stop:
   run `system1_client.py template`, fill it in yourself (the same shape; see
   `examples/ruxt-labs.briefing.json`), then `system1_client.py send FILE`.
   `send` validates the file (shape, enums, no `TODO` left, no permission
   decisions) before anything leaves.
4. **Report the outcome in a line or two:** which option was recommended, and
   System 1's response. If the client prints `NOT SENT`, say why and keep the
   briefing; do not ask the user how to proceed.

## What a good briefing looks like

- **3-4 options that differ in strategy** (scope, sequencing, build vs buy,
  depth vs speed), one of which is the do-less option. Reworded variants of the
  same plan are a failure.
- **Per option:** summary, what System 1 would run and in what order, what it
  falls back to if a step fails, cost / risk / reversibility (low-medium-high),
  time to first value, the upside, and the one downside that would hurt most.
- **One recommendation**, justified against the others in two or three sentences.
- **Assumptions** that were resolved on System 1's behalf, including every
  ambiguity in the task.
- **Selection guidance:** the rule System 1 applies to choose on its own,
  including when to prefer an option other than the recommended one, **and how
  its workers' questions get answered** (decide, smaller and more reversible
  reading, log the reason; permissions and credentials are held as BLOCKED).

## Payload and endpoints

```json
{"kind": "decision_options", "type": "decision_options", "mode": "autonomous",
 "briefing": { ... }, "recommended_option_id": "B"}
```

`chosen_option_id` is added only when forced with `send --choose ID`; by
default System 1 decides. Where it goes (`SYSTEM1_API_URL`):

| Value | Meaning |
|---|---|
| `http(s)://...` | An orchestrator service that accepts `decision_options`. |
| `file:PATH` | Append the payload as one JSON line to PATH; a manager agent reads it as its inbox. Works with no server at all. |

**System One is not that service.** The local System One
(`POST http://127.0.0.1:8600/upstream/system-one/v1/decide` through llama-swap;
plain `/v1/decide` is a 404 there) only takes `model_pick` scenarios. It reads
the field `kind`; the first version of this client sent only `type`, which System
One ignored, so it answered `200` with a model pick and the skill reported that
as System 1's response while the briefing had been thrown away. The client now
sends `kind` (System One refuses it with `400 decision_kind_refused`) and treats
a `model_pick` reply to a briefing as an error. `pick` is the command for System
One.

## Related pieces in this folder

- `client/system1_client.py` - `options`, `send`, `template`, `pick`
  (`pip install -r client/requirements.txt` is only needed for `options`)
- `client/test_system1_client.py` - 18 stdlib tests, no network or key needed:
  `python -m unittest discover -s orchestrator-options/client -p "test_*.py"`
- `examples/ruxt-labs.briefing.json` - a real briefing (running three jobs
  with a manager), valid input for `send`
- `plugin/system1-options/` - `/system1 <task>` command and a pane that shows
  the briefing and System 1's response (a Claude Code mod; runs the client)
- `extension/settings-snippet.json` - pre-approves the client and denies
  `AskUserQuestion` so a run cannot stop for input; replace the path
  placeholder with the absolute path of this folder

## Verified and not verified (2026-10-18, Windows)

Verified by running it: the stdlib client paths (validation, payload, file sink,
HTTP stub, false-success detection, `pick` against the real System One,
clean exit without a key) and the 18 tests. **Not verified:** the Anthropic call
in `generate_briefing` (parameters such as the `server-side-fallback-2026-07-01`
beta and `fallbacks="default"` were never executed: no key or SDK on that
machine) and the Claude Code mod in `plugin/` (never loaded). Treat both as
untested until someone runs them.
