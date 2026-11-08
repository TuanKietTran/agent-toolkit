# Client API

What a native client (phone or desktop) needs to talk to a lab board. The browser page uses the same
endpoints with a cookie; native clients use a bearer key instead.

## Starting the server for clients

```
lab-gui --listen 100.64.0.5 [--port 4317] [--allow-control] [--new-key]
```

- `--listen ADDR` binds that address (use a private network address; the connection is plain HTTP).
  Prints the origin, the pairing key and a `labgui://pair?url=<origin>&key=<key>` link.
- The key is kept in `~/.config/lab-gui/remote-key` (mode 600) so a paired device stays paired.
  `--new-key` replaces it. `LAB_GUI_KEY_FILE` overrides the location.
- Clients are **read-only** unless `--allow-control` is given. `attach` (opens a terminal window on the
  host) is never available remotely.
- 20 wrong keys from one address lock that address out for a minute (HTTP 429).

On the same machine, a client may instead talk to the loopback server (`lab-gui`, default port 4317):
it accepts the same bearer key header, but a loopback server's key is per launch and printed in its
link (`?key=`).

## Authentication

Every request: `Authorization: Bearer <key>`. No cookie, no CSRF token. Wrong or missing: `401
{"error": "..."}`. All bodies are JSON, `Content-Type: application/json` on POST.

## Endpoints

| Method and path | Purpose |
| --- | --- |
| `GET /api/info` | `{name:"lab-gui", api:1, remote, control, attach}`. Check `control` before showing send/stop/renew. |
| `GET /api/labs` | The snapshot (below). Poll every 1.5-3 s while the screen is visible; stop polling in the background. |
| `GET /api/stream` | Optional server-sent events, event `snapshot`, same payload. Polling is simpler on phones. |
| `GET /api/labs/{name}/screen?tail=N` | `{name, lines:[string], cols, rows, title}`; `tail` is the last N lines (default 40). |
| `POST /api/labs/{name}/send` | `{text, enter?:bool}` types text (and Enter unless `enter:false`). 403 when control is off. |
| `POST /api/labs/{name}/key` | `{key}` one of `Enter Esc Tab Up Down Ctrl-C` (the server rejects others). |
| `POST /api/labs/{name}/stop` | `{confirm: "<lab name>"}` stops the lab. Always ask the person first. |
| `POST /api/labs/{name}/renew` | `{confirm: "<lab name>"}` renews the lab: a fresh session starts in the same lab and its brief and the last resume-log lines are re-sent; the lab keeps running. Always ask the person first. 403 when control is off. |
| `POST /api/labs/{name}/attach` | Loopback only; refused remotely. |

Errors are `{error: string}` with 400 (bad input), 401, 403, 404, 413, 415, 429, 502 (the lab CLI failed).

## Snapshot (`GET /api/labs`)

See `fixtures/snapshot.json`. Fields, all always present unless marked optional:

```
{ at: number (ms epoch), error: string|null,
  totals: { total, working, asking, stalled, gone, costUsd, tokens },
  labs: [ { name, role: string|null, kind: "commander|manager|worker|builder|explorer|advisor|lab",
            parent: string|null, children: [name], state: "working|up|asking|stalled|gone",
            model: string|null, modelLabel: string, modelFamily: "opus|sonnet|haiku|fable|muse|opencode|other|unknown",
            quietMs: number|null, uptimeMs: number|null, title: string|null, cwd: string|null, pid: number|null,
            samples: [number]  // bytes of new output per poll, oldest first, up to 48: the activity sparkline
            usage: null | { input?, output?, cacheRead?, cacheWrite?, cacheHitPct?, costUsd?, contextPct?, contextWindow? } } ] }
```

Fields marked `?` inside `usage` may be missing. Treat unknown `kind`, `state` and `modelFamily` values
as plain/neutral so a newer server does not break an older client.

## What a client should show

The same board as the web page: the lab tree (commander to managers to workers) with the three team
roles drawn distinctly (builder, explorer, advisor), live state, the sparkline, model, token/cost
totals, and per lab: the live screen, a message box, keys, and stop and renew with confirmation (hidden when
`control` is false). Dark and light, accessible labels, no analytics, no requests to any host except the
paired server. Store the key in the platform keychain (Keychain, Credential Locker/DPAPI, Android
Keystore-backed encrypted storage), never in plain files or logs.

## Fixtures

`fixtures/{snapshot,screen,info}.json` are real output of the server's code against a fake fleet. Every
client's tests decode them, so a contract change shows up as a failing test in all four clients.
