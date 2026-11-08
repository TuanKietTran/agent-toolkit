---
name: lab-commander
description: >
  Command agent labs using h1. Spawn, brief, monitor,
  checkpoint, resume and close interactive agent sessions.
---

# Lab commander

Use `h1` to host and control interactive PTYs. `labctl` is a compatibility shim that execs `h1`. `install.sh` builds and installs the binary, then links this skill and `labctl`, `lab-watch`, and `lab-clean`. Requires the main CLI capability set (`open --help` succeeds).

## CLI and legacy detection

Detect the CLI by capability, not version: `h1 open --help >/dev/null 2>&1` succeeds on the main CLI and fails on legacy 0.1.0. Main CLI examples:

```sh
h1 open -n worker --role worker --parent mgr1 --cwd /absolute/repo -- pi --provider muse --model muse --thinking off --no-session
h1 send -n worker --file /absolute/brief.md --paced
h1 status -n worker
h1 stop -n worker
```

Consult `h1 <command> --help` for `open`, `send`, `status`, `watch`, `key`, `stop`, `list`, and `host` options. **Legacy 0.1.0:** use `host -s <name> -- <cmd>` (background), `send -s`, `screen -s`, `ask -s`, and `ls`; it has no stop command, so send `/quit` + Enter or Ctrl-C twice. Run `install.sh` to upgrade.

## Models: Muse first, opencode-cli sometimes

**Every manager and every worker is a Muse Pi lab.** Open each one with:

```sh
h1 open -n NAME --role manager|worker --parent PARENT --cwd /absolute/dir -- \
  pi --provider muse --model muse --thinking off --no-session
```

Muse quirks (learned running it as executor and manager): give it **one brief file per prompt**, and send the one-line pointer with `--paced`; if it refuses or wedges on a prompt, send `/new` and rebrief instead of arguing. Tell the user if Muse stalls as a manager; do not silently fall back to a Claude CLI lab.

**Sometimes switch to the opencode-cli extension's models** (`pi --list-models | grep opencode-cli`, for example `opencode/gpt-6-luna`, `opencode/gpt-6.1-sol`, `opencode/claude-sonnet-5-5`), when a step needs a stronger or different model, or Muse is down:

```sh
# at launch (the console shows this in the MODEL column)
h1 open -n w4 --role worker --parent mgr1 -- pi --provider opencode-cli --model opencode/gpt-6-luna --no-session
# inside a running lab
h1 send -n w4 -e '/model opencode-cli/opencode/gpt-6-luna'
```

opencode-cli goes through the free Zen quota (`provider.free-limit`, long retry-after once exhausted), so use it for the few steps that need it and go back to Muse. Pass `--model PROVIDER/ID` to `open` only when the program line does not say it (for example a lab switched in-session), so the console labels it correctly.

## Three-role team: builder, explorer, advisor

For work that needs a lead, cheap parallel reading, and an independent check, open a team of Claude labs with one command:

```sh
lab-team up -p demo --parent cmdr --cwd /absolute/repo      # demo-builder, demo-explorer, demo-advisor
lab-team plan -p demo                                        # print the open commands only
lab-team down -p demo                                        # stop advisor, explorer, builder
```

| Role | Model | Does | Rules |
| --- | --- | --- | --- |
| `builder` | Sonnet 5.5 | writes and runs the code | the only editing lab; one worktree |
| `explorer` | Haiku 5.5 | reads, searches, summarises, checks pages | read-only; send it questions that need many file reads |
| `advisor` | Opus 5.5 | reviews | consult sparingly: it spends the most quota |

All three are Pi labs on the `claude-cli` provider (`pi --provider claude-cli --model <id> --no-session`, started with the `CLAUDE_CODE_*` variables unset so a nested Claude Code does not inherit the parent's session). The explorer and advisor hang under the builder in the graph, the builder under `--parent`; `h1 console` colours the three roles and `lab-gui` draws them with their own shapes. Override a model with `LAB_TEAM_BUILDER_MODEL`, `LAB_TEAM_EXPLORER_MODEL`, `LAB_TEAM_ADVISOR_MODEL`.

**When to consult the advisor** (a handful of times per task, not per step):

1. **Plan review**: once, after the plan is written and before the first edit. Send the plan and the constraints, ask for gaps and risks only.
2. **Breaking an error loop**: after the same failure survives two honest fixes. Send the error, what was tried, and the relevant code.
3. **Final gap check**: once, before reporting done. Send the diff summary and the original requirements, ask what is missing or unverified.

Give the advisor the files or diff to read rather than a long retelling, and ask a closed question ("what would you change?") so the answer is short. Do not ask it to write code. Use the explorer for anything that is mostly reading, and stop it when the answer is in.

## Lab GUI

`lab-gui` (or `node packages/lab-gui/server.mjs --open`) serves a local browser view of the same graph at `http://127.0.0.1:4317/`: roles with their own shapes, live state, activity, model and token/cost counters, a live screen peek, message, stop (with confirmation) and attach. It binds loopback only and polls only while a page is open. See `packages/lab-gui/README.md`. The same board as a desktop app for macOS and Windows: `packages/lab-gui-desktop`.

## Lab graph and console

`open` records `--role` and `--parent`. A lab opened from inside a manager lab (the hosted program gets `H1_SELF=<its name>`) is attached to that manager automatically, so managers need no extra flags. Role is inferred when left out: has children, `manager`; has a parent, `worker`.

```sh
h1 console                    # opens a new terminal window (Ghostty on macOS; H1_TERMINAL / --terminal to change)
h1 console --here             # run in the current terminal instead
h1 console --snapshot --view graph   # one text frame, no terminal needed (for you, the commander, to read)
```

The console is a k9s-style TUI: `:labs`, `:graph`, `:models` (or `1 2 3` / Tab), `/` filter, `enter` peek the live screen, `d` describe, `a` attach in a new window, `m` message a lab, `ctrl-d` stop (asks first), `o` sort, `?` help. Open it for the user at the start of a run (`h1 console`) and use `--snapshot` to read the same state yourself.

## Session workflow

1. **Open:** start a named lab with `open` or `host` (Muse, with `--role` and `--parent`, see Models); use one worktree per editing worker and keep probe workers read-only.
2. **Brief:** send exactly one line pointing to the brief file; Enter submits immediately in Pi.
3. **Monitor:** use `lab-watch <name>` or inspect screen/status. Text sent while Pi is busy queues. `Working` in its status bar means busy.
4. **Checkpoint:** at phase boundaries, record marker lines in append-only `status/<name>.log`; screens scroll and recordings are raw ANSI.
5. **Reset/restart:** reopen and rebrief with the latest task and checkpoint; never assume retained state.
6. **Clean up:** use `lab-clean` and the resource rules below.
7. **Close:** stop the lab and verify it is gone.

## Worker protocol

Work unattended; do not ask the user. Print `LAB-CHECKPOINT <done / next>` at each phase boundary. Finish with `LAB-DONE <result>` or `LAB-BLOCKED <reason>` on its own line and append the same marker to `status/<name>.log`. A marker is valid only when it matches `^\s*LAB-(DONE|BLOCKED|CHECKPOINT)[ \t]+\S`; ignore markers from before the latest prompt. Never publish, merge to main, change visibility, or write secrets unless authorized.

## Operating protocol

Pi launch flags: `--model provider/id`, `--thinking <lvl>`, `--models <list>` for Ctrl+P cycling, and `-na` for untrusted clones; change models in-session with `/model <id>`. Managers must not end their turn while workers run: monitor in blocking bash loops kept below the tool timeout. `lab-watch` detects idle, status markers, blockers, usage limits, gone sessions, and timeout.

Keep `repo/`, `wt/<lab>/`, `notes/`, `status/`, `briefs/`, and `logs/` separate. Always pass **absolute paths** to `git worktree add`; relative paths under `git -C repo` can nest worktrees in the clone. If nesting occurs, add `wt/` to `.git/info/exclude`. Indent marker examples in briefs (for example, `- \`LAB-DONE result\``) so echoed text does not trigger false detections.

## Clean up resources

Stop with `stop`, or `/quit` + Enter / Ctrl-C twice on legacy. Verify the `h1` host exited; after about five seconds, identify any orphan with `pgrep -f "h1 host .*(-s|-n|--name) <name>( |$)"` and kill only that PID. Confirm with `list` (legacy: `ls`); remove a socket only when no host listens, then confirm again. `lab-clean <name> --workspace W [--cwd DIR|--session-dir DIR] [--into BRANCH]` performs safe workspace cleanup; `--session-dir DIR` selects the Pi session directory directly and takes precedence over `--cwd`; `--all` is scoped to names represented by `status/<name>.log` or `logs/<name>.*` in W.

Actively delete temp resources: clean each one immediately when it is no longer needed, not at the end of the run, and sweep for leftovers (temp files, scripts, build output, handoffs, sockets, worktrees) every time a lab finishes. `lab-clean` removes the named `<name>.host.log` by default; it retains `<name>.jsonl` unless `--purge-logs` is supplied. Keep `notes/` and reports. Use this timing guide:

| When verified / no longer needed | Cleanup |
| --- | --- |
| Worker verified; no incident to investigate | Purge its recording with `lab-clean <name> --workspace W --purge-logs` |
| Lab exits | Delete its `logs/<name>.host.log` (default behavior of `lab-clean`) |
| Temporary file, job, session, or worktree is no longer needed | Remove temp files/scripts/build dirs immediately; cancel Pi `start_job`; delete the lab's handoff (never archive or write one); remove/prune a clean merged worktree and branch with `--into BRANCH` (otherwise keep unmerged worktrees) |

**Fire and forget: no handoff files.** Never write a handoff, and do not ask labs for one; the brief and `status/<name>.log` are the only state. `lab-clean` deletes Pi `handoff.json` from the session directory (when `--cwd DIR` or `--session-dir DIR` is supplied) and any `W/logs/handoffs/<name>-*.json`, it never archives them. Remove only `W/tmp/<name>` by default. Keep recordings when an incident needs investigation; when purging, remember they may contain secrets. For clean worktrees under `W/wt/<name>` or `W/repo/wt/<name>`, remove/prune and delete the branch only if it is merged into `--into BRANCH`; otherwise skip. The helper is idempotent and never deletes notes or resources outside the workspace's own scope.
