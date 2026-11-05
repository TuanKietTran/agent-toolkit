# agent-cli-lab

A small Rust CLI for agents and humans to run another command inside a pseudo-terminal (PTY), interact with it, and optionally save a machine-readable session transcript.

## Direct interactive proxy

```sh
agent-cli-lab run -- command --flag
agent-cli-lab run --record session.jsonl -- command
printf 'answer\n' | agent-cli-lab run -- command
```

## Headless agent control

Start the PTY host as a long-running process, then control it from separate calls:

```sh
agent-cli-lab host -r pi.jsonl -- pi --no-session
agent-cli-lab send -e 'Reply exactly: HELLO'
agent-cli-lab screen
agent-cli-lab attach
agent-cli-lab send -e '/exit'
```

`ask [-i IDLE_MS] [-t TIMEOUT_S] 'text'` is send + Enter + wait until the screen stops changing + screen in one call (`agent-cli-lab ask -s SOCK 'Reply: HELLO'`). `screen` renders the current ANSI TUI into plain text. `attach` requires terminal stdin, foregrounds the hosted PTY in the current terminal, and forwards keys until Ctrl-]. `foreground [-s SOCKET] [-- COMMAND...]` opens an attached terminal in a new window when called from a non-terminal context; with a command, it first starts a detached host for it (`agent-cli-lab foreground -- pi`). Set `AGENT_CLI_LAB_TERMINAL` or pass `foreground --terminal NAME`; macOS defaults to Ghostty. `--enter`/`-e` sends carriage return, matching a real terminal Enter key.

## Named sessions and what they are doing

Several hosted programs at once, each in its own window, by name (spec 007):

```sh
agent-cli-lab open -n ux --title "ux lab" --cwd D:\work -- pi --no-session   # a visible window, QuickEdit off, sized, titled
agent-cli-lab list                                   # name, state, size, pid, program of every running session
agent-cli-lab send -n ux --paced --file brief.txt -e # typed in chunks so a TUI does not read it as a paste
agent-cli-lab key  -n ux Down*2 Enter                # named keys instead of escape sequences
agent-cli-lab wait -n ux --asking                    # block until a dialog is showing (exit 124 on timeout)
agent-cli-lab watch -n ux                            # one line each time it starts asking, stalls, or ends
agent-cli-lab status -n ux --json                    # working | asking | stalled | gone, size, quiet time
agent-cli-lab screen -n ux --tail 12 --compact       # only the last lines; --json [--spans] for cells and colours
agent-cli-lab stop -n ux
```

`stalled` means no output for a while and no dialog: the program ended its turn and waits for you, even if it only asked a question in plain words. Every command also works against hosts started before these commands existed (it falls back to `send` and `screen`), and `-s PATH` still works wherever `-n NAME` does.

## Console (k9s-style TUI)

```sh
agent-cli-lab console                 # new terminal window (Ghostty on macOS)
agent-cli-lab console --here          # this terminal
agent-cli-lab console --snapshot --view graph --width 130 --height 30   # one text frame
```

`labs` (table with role, parent, state, model, activity sparkline), `graph` (commander -> managers -> workers drawn as nodes and edges, plus an output-activity sparkline) and `models`. Keys: `:labs` `:graph` `:models`, `/` filter, `enter` peek, `d` describe, `a` attach in a new window, `m` message, `ctrl-d` stop, `o` sort, `?` help. It is a TUI rather than a GUI on purpose: labs are PTYs that already live in terminal windows, it works over SSH and needs no extra runtime. For a browser view of the same graph (role shapes, activity, token/cost counters, peek/message/stop), see [`packages/lab-gui`](../lab-gui). Roles `builder`, `explorer` and `advisor` (opened together by `lab-team`, see the lab-commander skill) have their own colours in the console.

The graph comes from `open --role ROLE --parent NAME [--model PROVIDER/ID]`. A session opened from inside another one is attached to it automatically (the hosted program gets `AGENT_CLI_LAB_SELF`).

## All agents on this machine

```sh
agent-cli-lab agents                       # every agent instance: labs, Claude Code sessions (including the one you are in), and every other detected agent CLI (see "What `agents` detects")
agent-cli-lab agents --json                # {generatedAt, agents:[...]} for scripts and GUIs
agent-cli-lab agents --publish --watch 5   # also keep ~/.agent-cli-lab/agents.json fresh (atomic writes) for other readers
agent-cli-lab console --view agents        # the same scan inside the console (key 4, or :agents)
```

Discovery is read-only and does not need the labs to cooperate: the process table finds every agent program and every lab host (the host's command line carries the lab's name, role, parent and model, in the current and the older `host -s NAME` form); `~/.claude/sessions/<pid>.json` gives each Claude Code session's id, status and directory, which is how the session you are typing in is found and marked; a transcript tail supplies the model, the token count and a short, redacted last message; a lab's own screen supplies working/asking/stalled and Pi's context figure. Helper processes (a browser native host, `claude mcp`) are not agents. Nothing is sent to any agent.

### What `agents` detects

Detection is data-driven: a rule table maps each harness `kind` to executable basenames and, for programs launched through an interpreter (`node`, `bun`, `deno`, `python3`, `python`, `uv`), script-path keywords. Built-in kinds: `claude`, `pi`, `opencode`, `codex`, `gemini`, `aider`, `cursor-agent`, `goose`, `amp`, `crush`, `qwen`, `kimi`, `droid`, `copilot-cli`, `cline`, `continue`, `cody`. Short, ambiguous names (`goose`, `amp`, `crush`, `droid`, `cline`, `cody`, and `cn` for Continue) are weak: a bare basename only counts from a known install path or with a script-keyword hit.

One record per session: interpreter and wrapper chains and a harness's own child processes are folded into the session's record, and a record from a lab host or a Claude session file takes precedence over a bare process match (`source`: `lab`, `claude-session`, `process`). Never reported as agents: lab hosts and terminals, editor helpers (`extensionHost`, `Code Helper`), MCP servers and helpers (`claude mcp`, `mcp-server`, `claude --chrome-native-host`), `--version`/`--help` probes, and `agent-cli-lab agents` itself.

`agents --kind KIND` accepts any string: a built-in kind, a custom kind defined in `~/.agent-cli-lab/harnesses.toml`, or an unknown name, which matches nothing (it is not an error).

Custom rules live in `~/.agent-cli-lab/harnesses.toml`, one `[[harness]]` table per rule:

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

## Platforms

Linux, macOS and Windows (native, through ConPTY) are supported. [`.github/workflows/ci.yml`](.github/workflows/ci.yml) builds and tests all three; see [`specs/006-cross-platform.md`](specs/006-cross-platform.md) for what has been verified on each.

| | `--socket PATH` is | Access |
|---|---|---|
| Linux, macOS | a Unix-domain socket file, removed when the child exits | mode `0600` |
| Windows | only a name: it is mapped to the named pipe `\\.\pipe\agent-cli-lab-<hash>` and no file is created; the pipe disappears when the host ends | a DACL that allows only the current user |

By default `host`, `send` and `screen` use `$AGENT_CLI_LAB_SOCKET`, or `agent-cli-lab.sock` under `$XDG_RUNTIME_DIR`, `$TMPDIR`, or the system temp directory. Override with `--socket PATH`/`-s PATH`; `agent-cli-lab socket -p` prints the resolved default. Short forms include `-r` for `--record`, `-C`/`-R` for `--cols`/`--rows`, and `-e`/`-c`/`-d` for `send --enter`/`--ctrl-c`/`--ctrl-d`. On Windows any path-like name works, for example `C:\Temp\pi.sock`.

On Windows, `run` ends a piped stdin with Ctrl-Z and Enter, because a console ignores Ctrl-D.

## Build and test

```sh
cargo build --locked
cargo test --locked
```

Needs Rust 1.85 or newer. On Windows, either the MSVC or the GNU toolchain works. See [`specs/005-local-lifecycle.md`](specs/005-local-lifecycle.md) for setup and teardown, including Docker.

See [`specs/`](specs/) for prioritized problems and acceptance criteria.

## Commander skill

[`../../skills/lab-commander`](../../skills/lab-commander) documents the `agent-cli-lab` CLI. `labctl` is a compatibility shim that execs `agent-cli-lab`. Run `skills/lab-commander/install.sh` to install the Rust binary and link the skill plus `labctl`, `lab-watch`, and `lab-clean`; the common `skills/install.py` installer handles skill and executable links, not Rust binary installation. The shell installer invokes the binary installation step before delegating to the common installer.
