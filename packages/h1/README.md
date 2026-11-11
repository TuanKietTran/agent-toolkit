# h1

A small Rust CLI for agents and humans to run another command inside a pseudo-terminal (PTY), interact with it, and optionally save a machine-readable session transcript.

## Direct interactive proxy

```sh
h1 run -- command --flag
h1 run --record session.jsonl -- command
printf 'answer\n' | h1 run -- command
```

## Headless agent control

Start the PTY host as a long-running process, then control it from separate calls:

```sh
h1 host -r pi.jsonl -- pi --no-session
h1 send -e 'Reply exactly: HELLO'
h1 screen
h1 attach
h1 send -e '/exit'
```

`ask [-i IDLE_MS] [-t TIMEOUT_S] 'text'` is send + Enter + wait until the screen stops changing + screen in one call (`h1 ask -s SOCK 'Reply: HELLO'`). `screen` renders the current ANSI TUI into plain text. `attach` requires terminal stdin, foregrounds the hosted PTY in the current terminal, and forwards keys until Ctrl-]. `foreground [-s SOCKET] [-- COMMAND...]` opens an attached terminal in a new window when called from a non-terminal context; with a command, it first starts a detached host for it (`h1 foreground -- pi`). Set `H1_TERMINAL` or pass `foreground --terminal NAME`; macOS defaults to Ghostty. `--enter`/`-e` sends carriage return, matching a real terminal Enter key.

## Named sessions and what they are doing

Several hosted programs at once, each in its own window, by name (spec 007):

```sh
h1 open -n ux --title "ux lab" --cwd D:\work -- pi --no-session   # a visible window, QuickEdit off, sized, titled
h1 list                                   # name, state, size, pid, program of every running session
h1 send -n ux --paced --file brief.txt -e # typed in chunks so a TUI does not read it as a paste
h1 key  -n ux Down*2 Enter                # named keys instead of escape sequences
h1 wait -n ux --asking                    # block until a dialog is showing (exit 124 on timeout)
h1 watch -n ux                            # one line each time it starts asking, stalls, or ends
h1 status -n ux --json                    # working | asking | stalled | gone, size, quiet time
h1 screen -n ux --tail 12 --compact       # only the last lines; --json [--spans] for cells and colours
h1 stop -n ux
```

`stalled` means no output for a while and no dialog: the program ended its turn and waits for you, even if it only asked a question in plain words. Every command also works against hosts started before these commands existed (it falls back to `send` and `screen`), and `-s PATH` still works wherever `-n NAME` does.

## Signals, events and relations

Sessions can message each other, watch each other's state, and declare how they are related (contract: `src/wire.rs`). All of it is in-memory state in each session's own host process, over the same per-session socket as the control commands above: there is no central daemon and nothing is written to disk. An edge is stored in both endpoint hosts. Streams print one JSON object per line (a `{"frame":"signal",...}` or `{"frame":"event",...}` object), ending with `{"frame":"end"}` when the host exits.

```sh
h1 relation add producer parent consumer --cascade   # producer is consumer's parent; ending producer stops consumer
h1 relation add consumer depends_on producer         # consumer needs producer; producer ending raises relation_ended on consumer
h1 signal emit -n producer --to consumer data.ready --text ready   # deliver a named signal to consumer's listeners
h1 signal listen -n consumer --signal data.ready --count 1           # print one matching signal and exit
h1 event subscribe -n consumer --kind exited,relation_ended --count 2   # consumer's state changes, one JSON event per line
h1 relation list -n consumer --json                  # every edge this host knows, both directions
h1 relation graph                                    # every edge across the running sessions
h1 relation remove consumer depends_on producer
```

- **Signals** are named, typed messages between sessions: `signal emit [-n FROM] (--to APP | --all) NAME [--type T] [--data JSON | --text TEXT]`, `signal listen -n APP [--signal N] [--type T] [--count N] [--timeout-ms MS]`. A name is `[A-Za-z0-9._-]{1,64}` (e.g. `data.ready`); `--type` is a payload label and defaults to `json`.
- **Events** are a host's own state changes: `started`, `asking`, `stalled`, `idle`, `exited` (detail carries `exit_code`), `closed` (the last event of a session) and `relation_ended`. `event subscribe (-n APP... | --all) [--kind K,K] [--count N] [--timeout-ms MS]` streams them; a new subscriber first gets the current state replayed as one event. A `relation_ended` event is delivered to the receiving session, with detail `{"ended": <name>, "relation": <kind>, "role": "from"|"to"}` (the role of the ended session in that edge).
- **Relations** are typed edges: `parent`, `supervises`, `depends_on`, `pairs_with` (symmetric). `relation add FROM KIND TO [--cascade]` is sent to `from` and mirrored to `to`. When a host ends it releases its edges to its peers: they drop the edge, raise `relation_ended`, and stop their children on `--cascade` parent edges (cascade is only meaningful for `parent`). In the console, `r` toggles a relations overlay on the graph view and `:events` is the events pane.

[`examples/signals-pair.yah`](examples/signals-pair.yah) brings the `producer`/`consumer` pair above up as one team.

## Console (k9s-style TUI)

```sh
h1 console                 # new terminal window (Ghostty on macOS)
h1 console --here          # this terminal
h1 console --snapshot --view graph --width 130 --height 30   # one text frame
```

`labs` (table with role, parent, state, model, activity sparkline), `graph` (commander -> managers -> workers drawn as nodes and edges, plus an output-activity sparkline) and `models`. Keys: `:labs` `:graph` `:models`, `/` filter, `enter` peek, `d` describe, `a` attach in a new window, `m` message, `ctrl-d` stop, `o` sort, `?` help. It is a TUI rather than a GUI on purpose: labs are PTYs that already live in terminal windows, it works over SSH and needs no extra runtime. For a browser view of the same graph (role shapes, activity, token/cost counters, peek/message/stop), see [`packages/lab-gui`](../lab-gui). Roles `builder`, `explorer` and `advisor` (opened together by `lab-team`, see the lab-commander skill) have their own colours in the console.

The graph comes from `open --role ROLE --parent NAME [--model PROVIDER/ID]`. A session opened from inside another one is attached to it automatically (the hosted program gets `H1_SELF`). `open --brief FILE [--resume-log FILE] [--new-cmd TEXT] [--ready-regex RE]` also stores those renew settings in the registry — paths and settings only, never file contents or secret values — so the session can later be renewed with its context.

### Preview mode

`h1 console --preview FILE` renders a `graphloop preview` document (see "Previewing a team" in the graphloop README) as a planned graph: the team as it would open, drawn alongside any live labs, with the preview's warnings shown in red. Loading a preview is a pure read — nothing is started, stopped, or written. Preview-mode keys: `P` loads a preview file, `p` toggles the preview overlay, `enter` shows the selected node's `open_command` and env, `u` shows the would-up summary (what would start, what is already running, what would stop), `o` sorts, `q` leaves preview mode.

## All agents on this machine

```sh
h1 agents                       # every agent instance: labs, Claude Code sessions (including the one you are in), and every other detected agent CLI (see "What `agents` detects")
h1 agents --json                # {generatedAt, agents:[...]} for scripts and GUIs
h1 agents --publish --watch 5   # also keep ~/.h1/agents.json fresh (atomic writes) for other readers
h1 console --view agents        # the same scan inside the console (key 4, or :agents)
```

Discovery is read-only and does not need the labs to cooperate: the process table finds every agent program and every lab host (the host's command line carries the lab's name, role, parent and model, in the current and the older `host -s NAME` form); `~/.claude/sessions/<pid>.json` gives each Claude Code session's id, status and directory, which is how the session you are typing in is found and marked; a transcript tail supplies the model, the token count and a short, redacted last message; a lab's own screen supplies working/asking/stalled and Pi's context figure. Helper processes (a browser native host, `claude mcp`) are not agents. Nothing is sent to any agent.

### What `agents` detects

Detection is data-driven: a rule table maps each harness `kind` to executable basenames and, for programs launched through an interpreter (`node`, `bun`, `deno`, `python3`, `python`, `uv`), script-path keywords. Built-in kinds: `claude`, `pi`, `opencode`, `codex`, `gemini`, `aider`, `cursor-agent`, `goose`, `amp`, `crush`, `qwen`, `kimi`, `droid`, `copilot-cli`, `cline`, `continue`, `cody`. Short, ambiguous names (`goose`, `amp`, `crush`, `droid`, `cline`, `cody`, and `cn` for Continue) are weak: a bare basename only counts from a known install path or with a script-keyword hit.

One record per session: interpreter and wrapper chains and a harness's own child processes are folded into the session's record, and a record from a lab host or a Claude session file takes precedence over a bare process match (`source`: `lab`, `claude-session`, `process`). Never reported as agents: lab hosts and terminals, editor helpers (`extensionHost`, `Code Helper`), MCP servers and helpers (`claude mcp`, `mcp-server`, `claude --chrome-native-host`), `--version`/`--help` probes, and `h1 agents` itself.

`agents --kind KIND` accepts any string: a built-in kind, a custom kind defined in `~/.h1/harnesses.toml`, or an unknown name, which matches nothing (it is not an error).

Custom rules live in `~/.h1/harnesses.toml`, one `[[harness]]` table per rule:

```toml
[[harness]]
kind = "myagent"
exe_names = ["myagent"]
script_keywords = ["myagent/dist/cli.js"]
weak_exe = false
```

Keys: `kind`, `exe_names`, `script_keywords`, `argv_keywords`, `interpreters`, `env_keys`, `exclude_argv`, `weak_exe`. A user rule whose `kind` matches a built-in replaces that rule's non-empty fields; a new `kind` is appended. A missing or malformed file is ignored and never breaks scanning. `env_keys` only document the marker variables that relocate a harness's home directory; they are never a required signal, and their values never appear in output.

`--json` records carry `kind`, `name`, `role`, `parent`, `pid`, `hostPid`, `cwd`, `model`, `status`, `context`, `uptime`, `last`, `tty`, `sessionId`, `source`, `managed`, `thisSession`. Every field except `status` may be absent. `tty` (the controlling terminal, absent for daemons) is new: older consumers can ignore it, and older files without it still parse.

Scan platform support: live-verified on macOS. On Linux the same `ps` table is used, with working directories read from `/proc/<pid>/cwd` instead of `lsof`; that path is not yet live-verified. The scan relies on `ps`, so it is not supported on Windows (the rest of the CLI is, see below).

## Agents: start and adopt

The four agent CLIs that `agents` reports as startable have their own start commands. Each one starts the program in an h1 session, with the same hosting as `open`, attached in its own window unless `--detached` is given. The session is named after the kind unless `-n` says otherwise, and `--cwd DIR` sets where the program starts:

```sh
$ h1 claude                       # a session named claude, attached
$ h1 pi -n research               # a session named research
$ h1 opencode --cwd /work/repo    # started in /work/repo
$ h1 codex --detached             # hosted but not attached: for scripts and tests
```

Anything after `--` is passed through to the program untouched:

```sh
$ h1 claude -- --model opus       # runs claude --model opus
$ h1 pi -- --no-session           # runs pi --no-session
```

An agent that is already running outside h1 can be brought in with `h1 adopt <PID|NAME>`, where the target is a pid or the exact name `h1 agents` reports; `h1 attach --agent <PID|NAME>` is the same operation through `attach`. A foreign process has no h1 PTY, so adopt does not take the process over: it starts a new h1 session (named with `-n`, or `adopt-<kind>-<pid>`) in the agent's working directory, running that kind's resume command for the session the agent already has:

| Kind | With a recorded session id | Without one |
|---|---|---|
| `claude` | `claude --resume <id>` | cannot be adopted: no recorded session id |
| `pi` | `pi --session <id>` | `pi --continue` |
| `opencode` | `opencode --session <id>` | `opencode --continue` |
| `codex` | `codex resume <id>` | `codex resume --last` |

```sh
$ h1 adopt 12345                  # resume the agent with pid 12345 in a new session
$ h1 adopt research --detached    # by name, hosted but not attached
$ h1 attach --agent 12345         # the same, through attach
```

Only those four kinds can be adopted: adopting any other detected kind fails with `<kind> cannot be adopted: only claude, pi, opencode and codex support resume`. A target that matches nothing fails saying no running agent matches it, and a name that matches more than one agent fails listing the matching pids; use a pid instead. If the target is already an h1 lab, adopt prints that it is already hosted by h1 and attaches to it instead of resuming.

The original process keeps running: adopt never kills or signals it, and the new session resumes its conversation while the old one is still alive. For `claude`, exit the original process first, so the two do not both write to the same session.

## Recoverable sessions

A lab can remember how to pick its work back up after you start it over with `/new`, without you pasting the brief again. `open` (and `host`) store **paths and settings only**, never file contents and never secret values:

- `--brief FILE`: the brief to re-arm with (absolute path).
- `--resume-log FILE`: a status log; its last five lines go into the re-arm prompt.
- `--new-cmd TEXT`: the command that starts a fresh session in the hosted program (default `/new`).
- `--ready-regex RE`: what the screen must show before the re-arm is typed (default: the screen is quiet for two seconds).
- `--auto-rearm`: the host watches what is typed into the lab and re-arms by itself when a submitted line is exactly the new-session command. Off by default.

`h1 renew -n NAME` renews a live lab on demand: it sends the new-session command, waits for the ready screen, then types the re-arm prompt and presses Enter once. The prompt is **one line**: a short header, the last five resume-log lines and the brief, with line breaks collapsed to spaces. A brief longer than 2000 characters is not inlined; the prompt says `read <brief path> and continue` instead. If the screen does not change after the prompt, `renew` exits with status 1 and a one-line reason and does not press Enter again.

With `--auto-rearm`, you type `/new` and Enter in the lab yourself (attached, or with `h1 send`), and the re-arm follows once the screen is ready. Only a submitted line that equals the new-session command counts: text that merely contains it, such as `please do not run /new yet`, does nothing, and backspace and arrow keys are followed. `h1 renew` does not trigger a second re-arm.

```sh
h1 open -n worker --detached --auto-rearm --brief /abs/brief.md --resume-log /abs/status.log -- pi
```

### Recover

If the host itself dies — a crash, a kill, a reboot — the registry record remains, and `h1 recover -n NAME` reopens the lab from it: the recorded command, working directory, size, title, role, parent and model, plus the stored brief, resume log, new-session command and ready pattern. `h1 recover --all` recovers every record whose host is gone. The record stores the **names** of the `--env` variables the lab was opened with, never their values: each value is taken from the current environment, and if a recorded name is not set there, recovery fails listing the missing names only. After reopening, recover runs the same re-arm as `renew` when a brief or resume log is stored, and prints `recovered NAME`. `h1 list` and the console hide a session whose host is gone but never delete its record (`h1 list --all` shows it); only `h1 stop` removes a record. Recover passes the recorded variable names with their current values to the reopened host as `--env NAME=value`, so those values are visible in that host's process arguments, exactly as with `h1 open --env`. A lab whose host still answers is refused and never touched. `h1 doctor` lists sessions that have a record but no host and says `h1 recover` would fix them.

## Platforms

Linux, macOS and Windows (native, through ConPTY) are supported. [`.github/workflows/ci.yml`](.github/workflows/ci.yml) builds and tests all three; see [`specs/006-cross-platform.md`](specs/006-cross-platform.md) for what has been verified on each.

| | `--socket PATH` is | Access |
|---|---|---|
| Linux, macOS | a Unix-domain socket file, removed when the child exits | mode `0600` |
| Windows | only a name: it is mapped to the named pipe `\\.\pipe\h1-<hash>` and no file is created; the pipe disappears when the host ends | a DACL that allows only the current user |

By default `host`, `send` and `screen` use `$H1_SOCKET`, or `h1.sock` under `$XDG_RUNTIME_DIR`, `$TMPDIR`, or the system temp directory. Override with `--socket PATH`/`-s PATH`; `h1 socket -p` prints the resolved default. Short forms include `-r` for `--record`, `-C`/`-R` for `--cols`/`--rows`, and `-e`/`-c`/`-d` for `send --enter`/`--ctrl-c`/`--ctrl-d`. On Windows any path-like name works, for example `C:\Temp\pi.sock`.

On Windows, `run` ends a piped stdin with Ctrl-Z and Enter, because a console ignores Ctrl-D.

## Doctor

```sh
h1 doctor   # diagnose rename/migration problems; exit 1 if anything needs attention
```

`h1 doctor` prints names and paths only, never registry values: the registry dir in use (`$H1_DIR` if set, else the resolved temp default) and whether it exists, whether the pre-rename registries still hold sessions — the one under the home dir and the one under the temp dir that the pre-rename tool actually used (a single warning line each if so, because those labs will not show in the TUI/GUI), which `h1` and old-named binaries and the `labctl` compatibility shim are on `PATH`, whether the lab-commander skill links resolve, whether the lab-gui port (`$LAB_GUI_PORT`, default 4317) is reachable, and whether any running process is an old-named binary or a lab-gui server started from outside this repo (one warning line per such process, naming its pid and, for lab-gui, its port). The lab-gui port check is informational only (it is started on demand), as are a not-yet-created registry dir, an empty pre-rename registry, and a lab-gui server running from this repo. Exit is 1 when a pre-rename registry still holds sessions, an old-named binary is still on `PATH`, `h1` is missing from `PATH`, a skill link is broken, an old-named process is still running, or a lab-gui server runs from outside this repo; otherwise 0. With `--fix-hints`, after the findings doctor prints a fix-hints section with the exact shell command for each fixable finding (`kill <pid>` for a stale old process, `ln -sfn <this repo>/skills/lab-commander <link path>` for a broken lab-commander skill link, `rm` for the stale old-named binary on `PATH`); those commands are printed only, never executed, and findings with no safe one-line fix (such as an old registry still holding sessions) get no hint. Doctor also prints two system-one lines (where the system-one package was found, or that it was not found and where it looked, plus a sample pick against a small catalog, falling back to `claude-sonnet-5-5` when system-one is unavailable or chooses an unknown model); those lines are informational only and never affect the exit code. With `--set-system-one <dir>`, doctor first validates `<dir>` as a system-one package directory (it must contain `src/system_one`) and stores it in the h1 config directory for later picks, printing `system-one: stored <dir>`, then runs the normal diagnosis; an invalid directory is an error and nothing is stored.

Doctor output is stable: the status lines below always appear in this order, followed by any process findings (one per matching process, in process-list order), then the fix-hints section (only with `--fix-hints` and only when at least one hint exists), then the verdict line. Paths, counts, pids, subcommand names and ports vary; the wording does not. One verbatim sample per line kind and variant:

- Current registry dir, exists: `registry dir: /tmp/h1 (exists)`
- Current registry dir, not created yet: `registry dir: /tmp/h1 (not created yet)`
- Old temp-dir registry still holds sessions (attention): `old registry /tmp/agent-cli-lab still holds 2 sessions: those labs do not show in h1 console/GUI`
- Old temp-dir registry present but empty: `old registry dir: /tmp/agent-cli-lab (present, 0 sessions)`
- Old temp-dir registry absent: `old registry dir: /tmp/agent-cli-lab (not present)`
- Old home-dir registry still holds sessions (attention): `warning: old registry /Users/x/.agent-cli-lab still holds 1 session(s) while /tmp/h1 is in use - old labs will not show in TUI/GUI`
- Old home-dir registry exists but holds no sessions: `old registry dir: /Users/x/.agent-cli-lab (exists, no sessions)`
- Old home-dir registry absent: `old registry dir: /Users/x/.agent-cli-lab (not present)`
- `h1` found on `PATH`: `h1 on PATH: /Users/x/.local/bin/h1`
- `h1` missing from `PATH` (attention): `h1 on PATH: not found`
- Old binary still on `PATH` (attention): `old binary agent-cli-lab on PATH: /Users/x/.local/bin/agent-cli-lab (stale, pre-rename)`
- Old binary not on `PATH`: `old binary agent-cli-lab on PATH: not found`
- `labctl` shim on `PATH`: `labctl shim on PATH: /Users/x/.local/bin/labctl (compatibility shim, execs h1)`
- `labctl` shim not on `PATH`: `labctl shim on PATH: not found`
- Skill link resolves: `skill link /Users/x/.codex/skills/lab-commander: ok`
- Skill link broken (attention): `skill link /Users/x/.codex/skills/lab-commander: broken`
- Skill link absent: `skill link /Users/x/.codex/skills/lab-commander: not installed`
- Lab-gui port reachable: `lab-gui port 4317: reachable`
- Lab-gui port not reachable: `lab-gui port 4317: not reachable`
- System-one found: `system-one: found at /Users/x/system-one`
- System-one not found: `system-one: not found (looked: H1_SYSTEM_ONE_DIR (unset))`
- Sample pick via system-one: `system-one sample pick: claude-haiku-5-5 (via system-one: test-rule test reason)`
- Sample pick, fallback on unknown model: `system-one sample pick: claude-sonnet-5-5 (via fallback: system-one chose unknown model claude-unknown-0)`
- Sample pick, fallback when unavailable: `system-one sample pick: claude-sonnet-5-5 (via fallback: system-one unavailable: boom)`
- Old console process (attention): `old console pid 1234 cannot see h1 labs: close it and run h1 console`
- Other old-binary process (attention): `old process pid 1235 (host) runs the pre-rename binary: restart it as h1`
- Lab-gui process started from this repo: `lab-gui on port 4317 started from /Users/x/checkout/packages/lab-gui/server.mjs: current (this repo)`
- Lab-gui process started from outside this repo (attention): `lab-gui on port 4317 started from /other/checkout/packages/lab-gui/server.mjs: restart it if it shows no labs`
- Verdict, nothing needs attention: `doctor: ok`
- Verdict, something needs attention (exit 1): `doctor: attention needed`

With `--fix-hints`, each hint is printed on its own line, indented by two spaces, under a header line. The `kill` hint is emitted for an old-binary process and for a lab-gui process started from outside this repo; the `ln -sfn` hint only for a broken lab-commander skill link, with its source copied from a skill link that already resolves; when no skill link resolves, the fallback line replaces the `ln -sfn` hint (at most once); and the warning line is always printed immediately above the `rm` hint for the stale old binary:

```
fix hints (print only, not executed):
  kill 1234
  ln -sfn /Users/x/checkout/skills/lab-commander /Users/x/.codex/skills/lab-commander
  no working skill link to copy: run skills/lab-commander/install.sh from your checkout
  only after your lab-commander checkout contains the h1 rename (git pull); the installed labctl and lab-* scripts call the old binary until then
  rm /Users/x/.local/bin/agent-cli-lab
```

## Migration

The binary was renamed from `agent-cli-lab` to `h1`; `labctl` remains as a compatibility shim that execs `h1`. Every environment variable was renamed with it:

| Before | After |
|---|---|
| `AGENT_CLI_LAB_AGENTS` | `H1_AGENTS` |
| `AGENT_CLI_LAB_BIN` | `H1_BIN` |
| `AGENT_CLI_LAB_DIR` | `H1_DIR` |
| `AGENT_CLI_LAB_NAME` | `H1_NAME` |
| `AGENT_CLI_LAB_SELF` | `H1_SELF` |
| `AGENT_CLI_LAB_SOCKET` | `H1_SOCKET` |
| `AGENT_CLI_LAB_TERMINAL` | `H1_TERMINAL` |

Move the data directory to its new location:

```sh
mv ~/.agent-cli-lab ~/.h1
```

### From graphloop

The standalone `graphloop` binary is gone: its Graphspec (`.yah`) commands are now subcommands of `h1`, with the same arguments and flags — replace `graphloop` with `h1`:

| Before | After |
|---|---|
| `graphloop check FILE` | `h1 check FILE` |
| `graphloop plan FILE` | `h1 plan FILE` |
| `graphloop graph FILE` | `h1 graph FILE` |
| `graphloop up FILE` | `h1 up FILE` |
| `graphloop down RUN` | `h1 down RUN` |
| `graphloop vault status FILE` | `h1 vault status FILE` |
| `graphloop runs` | `h1 runs` |
| `graphloop trace RUN` | `h1 trace RUN` |

Your `.yah` files need no changes. The Graphspec document and the examples stay where they were, under `packages/graphloop/docs/` and `packages/graphloop/examples/`; only the binary merged.

## Build and test

```sh
cargo build --locked
cargo test --locked
```

Needs Rust 1.85 or newer. On Windows, either the MSVC or the GNU toolchain works. See [`specs/005-local-lifecycle.md`](specs/005-local-lifecycle.md) for setup and teardown, including Docker.

See [`specs/`](specs/) for prioritized problems and acceptance criteria.

## Commander skill

[`../../skills/lab-commander`](../../skills/lab-commander) documents the `h1` CLI. `labctl` is a compatibility shim that execs `h1`. Run `skills/lab-commander/install.sh` to install the Rust binary and link the skill plus `labctl`, `lab-watch`, and `lab-clean`; the common `skills/install.py` installer handles skill and executable links, not Rust binary installation. The shell installer invokes the binary installation step before delegating to the common installer.
