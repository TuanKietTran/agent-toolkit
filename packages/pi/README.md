# pi

A small CLI that installs things onto a **host** or into a **container**, one
extension at a time. The core knows nothing about Docker, zlib, ffmpeg or
Jellyfin — it only knows how to find extensions, check them, and run them.

```
pi list
pi info jellyfin-ext
pi doctor jellyfin-ext
pi install zlib-ext --container=jellyfin
pi install jellyfin-ext --set media-path=/srv/media
```

## Install

```bash
git clone <this repo> pi
cd pi
npm install
npm run build
npm link          # optional: puts `pi` on your PATH
```

Without `npm link`, run it directly: `node dist/src/cli.js <command>` (or
`npm run dev -- <command>` to run the TypeScript sources through tsx).

Requires Node 20+. The extensions bundled here install Debian/Ubuntu packages,
so the *target* is expected to be Debian-family; the machine running `pi`
itself can be anything Node runs on.

## Commands

| Command | What it does |
|---|---|
| `pi list` | every extension pi can see |
| `pi info <ext>` | what it does, what it requires, what it can be configured with |
| `pi check <ext>` | is it installed on the target? (exit 3 if not) |
| `pi doctor [ext]` | check an extension and everything it requires, or everything |
| `pi install <ext>` | check prerequisites, install, verify |
| `pi remove <ext>` | uninstall, for extensions that implement it |

Flags: `--target=host|container`, `--container=<name>`, `--set key=value`,
`--dry-run`, `--force`, `--skip-requires`, `--json`, `--verbose`, `--quiet`,
`--yes`.

Exit codes: `0` ok, `1` error, `2` bad usage, `3` check failed, `4`
prerequisites missing. `--json` puts a machine-readable result on stdout and
keeps all human output on stderr, so `pi doctor --json | jq` works.

## Extensions

| Extension | Role | Requires (at run time) |
|---|---|---|
| `pi-ext` | baseline: shell, package manager, root, ca-certificates/curl | — |
| `docker-ext` | Docker installed, running, usable (host only) | — |
| `zlib-ext` | `zlib1g` + `zlib1g-dev`, and the unversioned `libz.so` link | — |
| `ffmpeg-ext` | ffmpeg + the VA-API stack for the target's GPU | — |
| `jellyfin-ext` | Jellyfin in its own container (host only) | `docker-ext`, `zlib-ext`, `ffmpeg-ext` |

**Extensions never import each other.** `requires` is a *runtime* relationship:
before `install()`, pi calls each prerequisite's `check()` and stops if any
fails, telling you which command to run. It never installs prerequisites for
you, so the boundary between extensions stays explicit. `--skip-requires` is
the escape hatch when you know the target already has what it needs — for
example a containerised Jellyfin, whose image ships its own ffmpeg, so the
host's ffmpeg is beside the point.

### Writing one

A directory under `exts/` (or `~/.pi/exts`, or anywhere on `$PI_EXTS_PATH`)
with two files:

```ts
// manifest.ts
export const manifest: ExtManifest = {
  name: "thing-ext",
  version: "0.1.0",
  description: "installs the thing",
  requires: ["docker-ext"],       // runtime check only
  targets: ["host", "container"],
  config: [{ key: "version", description: "which version", default: "latest" }],
};

// index.ts
export const plugin: InstallerPlugin = {
  name: "thing-ext",
  async check(target, ctx) { return succeeds(ctx.run, target, ["sh", "-c", "command -v thing"]); },
  async install(target, ctx) { await ctx.run(target, ["sh", "-c", "apt-get install -y thing"], { sudo: true }); },
  // remove() is optional
};
```

`ctx.run` wraps the command for the target — a host command runs as-is, a
container command becomes `docker exec <name> …` — and honours `--dry-run`.
Probes (via `succeeds`, or `readOnly: true`) still run under `--dry-run`, so a
rehearsal reports the target's real state.

## Configuration

Three sources, later ones winning:

1. `~/.pi/config.json` — `{ "jellyfin-ext": { "media-path": "/srv/media" } }`
2. environment — `PI_JELLYFIN_EXT_MEDIA_PATH=/srv/media`
3. flags — `--set media-path=/srv/media`

`pi info <ext>` lists the keys an extension understands.

## Jellyfin deployment

```bash
pi doctor jellyfin-ext                       # what is missing on this host
pi install docker-ext
pi install zlib-ext
pi install ffmpeg-ext
pi install jellyfin-ext --set media-path=/srv/media
```

Decisions baked into `jellyfin-ext`:

- **Dedicated container.** A bad upgrade is one `docker rm` away from a
  rollback.
- **Data outlives the container.** `config-path`, `cache-path` and
  `media-path` are host paths; media is mounted read-only at `/media`.
  `pi remove jellyfin-ext --yes` deletes the container and nothing else.
- **Tailscale-only.** The published port binds to this host's Tailscale IPv4
  address, discovered with `tailscale ip -4`. There is no default that exposes
  Jellyfin publicly: binding `0.0.0.0` needs both `--set bind-address=0.0.0.0`
  and `--set allow-public-bind=true`.
- **GPU passthrough is config, not a constant.** `/dev/dri` is passed through
  when it exists; `--set devices=/dev/dri,/dev/kfd` or `--set devices=none`
  overrides it. The container also joins the host's `render`/`video` groups.
- **An unreachable registry is survivable.** If `docker pull` fails but the
  image is already on the host, pi says so and carries on.

## Development

```bash
npm run typecheck
npm test           # 42 tests: unit, plus the CLI driven as a subprocess
npm run build
```

Tests never touch a real host: `test/fixtures/exts/fixture-ext` is a throwaway
extension loaded through `PI_EXTS_PATH` that writes a marker file, which is how
the dry-run and idempotency behaviour is checked.

The container path (`--container=<name>`) has been exercised end to end against
a real Debian container: `pi install zlib-ext`, `pi install ffmpeg-ext`,
`pi check`, `pi remove`. `jellyfin-ext` has been deployed and removed for real
against a live Docker daemon.
