---
description: Manage self-hosted sshd devboxes on bourbon (Windows box, Rancher Desktop/dockerd, reached via Tailscale SSH). Use whenever the user wants to create, mount into, or auto-provision a devbox from a devcontainer.json — our DIY equivalent of GitHub Codespaces, without GitHub.
argument-hint: [create|list|start|stop|rm|ssh|logs] [name] [--mount host:container]
---

# bourbon devbox management

## The setup

`bourbon` is a Windows machine reached over Tailscale SSH (`ssh bourbon`, user `cafe`).
It runs **Rancher Desktop** with the **dockerd (moby)** engine. This was
previously documented here as containerd/nerdctl; that is **wrong** and cost real
time — `nerdctl` aborts on a `/run/k3s/containerd/containerd.sock` that does not
exist, and pointing it at the Docker-managed containerd socket only reaches the
`moby` namespace, where container names come back blank because dockerd owns that
metadata. Containers are managed via `wsl -d rancher-desktop -e docker ...`,
which hops: this Mac → bourbon (Windows, cmd.exe) → the WSL Linux VM
(Alpine/musl, `rancher-desktop-wsl-distro`) → docker → dockerd.

`wsl -e docker` passes argv straight through **with no intervening shell**, so
the quoting minefield below does not apply to calls made that way, and exit
codes propagate correctly.

**The tool: `/Users/kyle/.local/bin/devctl`.** Always use it instead of raw
`ssh bourbon 'wsl -d rancher-desktop -e docker ...'` calls — it already handles the
quoting minefield below. Canonical backup lives at `scripts/devctl` in this skill's repo
(and `scripts/devctl-bourbon-local`, the variant that runs **on** bourbon with the
ssh hop dropped — keep both in step)
(`github.com/TuanKietTran/claude-skills`) — if you edit `~/.local/bin/devctl`,
copy the change back here and commit, they will drift otherwise.

```
devctl create <name> [--mount <host-path>[:<container-path>]]
devctl list
devctl start|stop|rm|ssh|logs <name>
```

- `<name>` → container `<name>-devbox`, SSH host `<name>-devbox` (auto-added to
  `~/.ssh/config` as `HostName localhost` / assigned port / `ProxyJump cafe@bourbon`).
- Base image: `python:3.14-slim` + openssh-server/git/build-essential/curl/sudo/tmux,
  non-root user `kyle` with passwordless sudo, pubkey-only SSH.
- `--mount` bind-mounts a path **as seen from bourbon's Rancher Desktop Linux VM**
  (e.g. `/mnt/d/projects/chatgpt-orchestrator` for `D:\projects\chatgpt-orchestrator`
  — bourbon's `C:` and `D:` are mounted at `/mnt/c` and `/mnt/d` inside that VM.
  **Projects live on `D:\projects\` as of 2026-08-29**, not `C:\<name>`.)
  Container path defaults to
  `/home/kyle/workspace`.

## devcontainer.json auto-provisioning (the Codespaces-equivalent bit)

If `--mount` is given and `<container-path>/.devcontainer/devcontainer.json` exists
at create time, `devctl` **automatically**:

1. Extracts `postCreateCommand` (tolerant of `//` and `/* */` comments — string-aware,
   so it won't corrupt a value containing a URL like `https://...`; see gotcha below).
2. Runs it inside the *same* sshd container, as root (so `apt-get` etc. just work),
   with `HOME=/home/kyle` (so `curl | sh`-style installers like `uv`'s land under
   kyle's home, not root's).
3. `chown -R kyle:kyle /home/kyle` afterward, so everything the command created
   is immediately usable by `kyle` over SSH — no manual permission fixing.

**Deliberate scope limit:** only `postCreateCommand` is honored. `image`, `build`,
and `features` in `devcontainer.json` are **ignored** — the devbox always uses
devctl's own sshd base image, because SSH access is the whole point of this setup
and an arbitrary devcontainer image won't have sshd/kyle/sudo wired up. If a
project's devcontainer.json needs a different base image or `features`, that's a
manual Dockerfile edit, not something devctl auto-handles.

This means: one container per devbox, always SSH-reachable, with real project
dependencies installed. Compare to `devcontainer up` (see below) which spins up a
*separate*, non-SSH-reachable container — don't use that for routine dev work now
that devctl has native support.

## Operational caveats (recreate/restore workflow)

- **`postCreateCommand` only runs at `devctl create` time**, never on `devctl start`.
  Editing `devcontainer.json` or a lockfile later does not re-trigger provisioning —
  rerun the relevant command by hand inside the box, or `devctl rm` + `devctl create`
  to fully re-provision from scratch.
- **No `--restart=always`** on devbox containers. After bourbon reboots or Rancher
  Desktop restarts, devboxes come back *stopped*. Always `devctl list` first;
  `devctl start <name>` before assuming SSH will work.
- **SSH host-key churn on recreate — devctl now handles this automatically.**
  `cmd_create` runs `ssh-keygen -R "[localhost]:<port>"` before starting the new
  container, so a stale known_hosts entry from a previous container on that port
  doesn't block the first reconnect. (If you ever bypass devctl and hand-roll a
  container on a reused port, you'll still need to do this yourself.)
- **`.venv`/caches on the bind mount are cross-filesystem** from the container's own
  layer (mount is a Windows path passed through via `/mnt/d/...`), so `uv` and
  similar tools fall back from hardlinks to full copies — slower, not broken.
  `export UV_LINK_MODE=copy` silences the warning.
- **Browser automation projects (playwright/patchright) need an extra explicit
  step** `postCreateCommand` usually doesn't include by default: installing the
  actual browser binary, not just the Python package —
  `uv run patchright install --with-deps chromium` (the `--with-deps` pulls in the
  ~60 apt packages headless Chromium needs on Debian slim; skip it and it'll fail at
  launch with missing `.so` errors). Put this in the project's own
  `postCreateCommand` once confirmed working, so `devctl create` picks it up
  automatically next time.
- **If the project launches browsers with `headless: false`** (chatgpt-orchestrator
  does this deliberately — headed browsers are harder for bot-detection to flag),
  it will fail with "Missing X server or $DISPLAY" since the devbox has no display
  server. Fix: `apt-get install -y xvfb xauth`, then prefix the actual command with
  `xvfb-run -a` (e.g. `xvfb-run -a uv run orchestrator doctor`) — don't "fix" this
  by flipping `headless: true`, that changes real application behavior, not just
  the dev environment. Add `xvfb xauth` to the project's `postCreateCommand` once
  confirmed working, same as the browser binary above.

## Hard-won gotchas (don't re-derive these)

- **`docker inspect <name>` matches images too**, not just containers — a leftover
  image from a prior build makes `devctl create` falsely report "already exists".
  Always use `docker container inspect <name>` for existence checks. (Same trap
  applied to nerdctl's `inspect --type container`.)

- **`docker pull` fails until a credential-helper shim exists.** Rancher ships a
  **glibc-linked** `docker-credential-secretservice`, but this distro is
  **musl with no `/lib64`**, so exec dies with `no such file or directory` — that
  message is about the missing ELF interpreter, not a missing helper (the file is
  right there). `DOCKER_CONFIG` overrides do not help. Fix: a POSIX-sh shim at
  `/usr/local/bin/docker-credential-secretservice` (that dir precedes Rancher's in
  PATH) answering `get` with empty credentials so pulls go anonymous. Without it,
  `devctl create` dies at `load metadata for python:3.14-slim`. A Rancher upgrade
  may reset it.

- **In Git Bash, a `/var/run/...` argument gets rewritten** to
  `C:/Program Files/Git/var/run/...` by MSYS path conversion, which makes socket
  errors name a path that was never real. Set `MSYS_NO_PATHCONV=1` when
  diagnosing.
- **Quoting survives exactly one round-trip of naive passthrough, no more.** The
  chain is: bash (this Mac) → single `ssh bourbon "<string>"` → Windows cmd.exe →
  `wsl -e` → Linux VM → (optionally) `docker exec` → container shell.
  Note this bites only when a *shell* sits in the chain: `wsl -d rancher-desktop
  -e docker ...` run directly on bourbon takes argv verbatim and is safe.
  Anything with pipes, `&&`, quotes, or multi-line content **must** be base64-encoded
  locally and decoded remotely (`echo <b64> | base64 -d | sh`) — see
  `container_exec_script()` in devctl. Don't try to hand-quote through more than one
  hop; it will silently mangle or truncate.
- **A naive `//.*` comment-stripping regex breaks JSON values containing URLs**
  (e.g. `postCreateCommand` with `https://astral.sh/uv/install.sh` gets truncated
  mid-line, corrupting the JSON, causing silent parse failure). devctl's parser is
  string-aware to avoid this — don't regress it back to a naive regex.
- Non-interactive `ssh host 'cmd'` does **not** source `.bashrc`/`.profile` (not a
  login shell). To test something that depends on PATH additions from an installer
  (uv, nvm, etc.), use `ssh host 'bash -lc "..."'`.
- Rancher Desktop's WSL VM has a real `/usr/bin/docker` binary, but no
  `dockerd`/socket — running it fails looking for `/var/run/docker.sock`. There's a
  working `docker` at `/usr/bin/docker` talking to the real dockerd. (An older note
  here described a `/usr/local/bin/docker` shim that exec'd nerdctl; that is no
  longer what is on the box.)

## Fallback: full devcontainer.json spec compliance via `@devcontainers/cli`

Node/npm and `@devcontainers/cli` are installed inside the Rancher Desktop WSL VM
(`ssh bourbon 'wsl -d rancher-desktop -e devcontainer --version'`), for cases devctl's lightweight
`postCreateCommand`-only path can't handle (full `features`, lifecycle ordering,
`build` args, etc.):

```
ssh bourbon 'wsl -d rancher-desktop -e sh -c "devcontainer up --workspace-folder /mnt/d/projects/<project>"'
```

This is spec-correct (same engine as VS Code/Codespaces) but creates a **separate**
container with no sshd/SSH access — only `devcontainer exec`. Treat it as a
one-off validation tool, not the routine workflow. Known gotcha: if the
devcontainer.json sets a custom `workspaceFolder`, also set a matching
`workspaceMount`, or the CLI mounts at its computed default
(`/workspaces/<folder-name>`) while `cwd` points elsewhere, and the container
fails to start with a `chdir` error.

## Debugging primitives

- Raw shell in the Linux VM: `ssh bourbon 'wsl -d rancher-desktop -e sh -c "<cmd>"'`
- List everything: `ssh bourbon 'wsl -d rancher-desktop -e docker ps -a --format "{{.Names}}|{{.Status}}|{{.Ports}}"'`
- Exec into a running container: `ssh bourbon 'wsl -d rancher-desktop -e docker exec <cname> <cmd>'`
- `devctl list` is the friendly version, filtered to `*-devbox` names.
