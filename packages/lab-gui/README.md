# lab-gui

A local web GUI for [`h1`](../h1): the lab graph, live state, a peek at each lab's screen, and message / stop / attach controls. It is the browser counterpart of `h1 console`.

```sh
node packages/lab-gui/server.mjs --open      # or: npm start --prefix packages/lab-gui
lab-gui --port 4400                          # after skills/lab-commander/install.sh (links bin/lab-gui)
```

The server prints a link such as `http://127.0.0.1:4317/?key=…` (default port; `--port 0` picks a free one) and `--open` opens it. The key in the link is the launch key: the page swaps it for a cookie and nothing is served without it, so open the printed link rather than the bare address. Needs Node 20 or newer and `h1` on `PATH` (override with `H1_BIN`). `H1_DIR` selects which labs it sees, exactly as for the CLI. There are no dependencies to install.

Desktop apps for macOS and Windows that wrap this server live in [`../lab-gui-desktop`](../lab-gui-desktop).

## What it shows

- **Graph**: lead to helpers, drawn left to right. Each role has its own shape and colour plus a letter badge, so it still reads without colour: builder (rounded rectangle, B), explorer (pill, E), advisor (cut-corner octagon, A), commander (hexagon), manager (square corners), worker (dashed). The three-role team from `lab-team` is Sonnet builds, Haiku explores, Opus reviews.
- **Live state** per lab: working, asking, stalled, gone (a lab that vanished stays on the board for a minute), with a pulse on working labs and flowing edges to working children.
- **Activity sparkline** per lab, from the growth of the lab's output.
- **Model** per lab and **tokens / cost** where the lab prints them: Pi's footer (`↑in ↓out R… W… $cost ctx%`) is read from the screen. Labs that show no such footer say "not reported".
- **Graphspec overlay**: when graphloop run manifests are present in the session dir's `graphs/` folder, each live lab gains its resolved model and pick provenance (team, run, harness, requested vs resolved model, pick rule/reason, tools), manifest nodes that are not running yet appear as dashed **planned** nodes, `member` edges and a per-team header (up / total per run) are shown, and stale manifests with no live node are ignored.
- **Side panel** (bottom sheet on a phone): live screen, a message box (Enter sends, Shift+Enter adds a line), buttons for Enter and Esc, **Attach** (opens the lab in a terminal window) and **Stop…** (asks first).
- Themes, switched the way Omarchy does it (below), layout down to phone width (the graph becomes a list), keyboard use throughout (`?` lists the keys).

## Themes

A theme is a folder `themes/<name>/colors.toml` holding a flat palette (`mode`, `accent`, `background`, `foreground`, `red`, `yellow`, `green`, `cyan`, `blue`, `magenta`, plus optional extras), the same layout and keys as [Omarchy](https://github.com/basecamp/omarchy)'s theme files, so a theme can be dropped in from there unchanged. The 23 Omarchy palettes (MIT licensed, each following its upstream colour scheme: Tokyo Night, Catppuccin, Catppuccin Latte, Gruvbox, Nord, Rose Pine, Kanagawa, Everforest and more) ship with the GUI.

- `t` opens the theme picker: the arrow keys preview each theme live, `Enter` keeps one, `Esc` goes back to the previous one. Typing a letter jumps to the next theme starting with it. `Shift+T` switches to the next theme (Omarchy's "theme next"). The choice is remembered in the browser. "System" follows the operating system's dark/light setting.
- One template (`public/theme.js`) turns a palette into the page's colours. Palettes were not designed as UI colour sets, so every text and accent colour is nudged toward the foreground until it reaches WCAG AA contrast (4.5:1) against the page, surface and raised backgrounds; a test checks every shipped theme.
- The list is read from disk on each request, so a new folder under `themes/` shows up after reopening the picker, no restart. A folder with a missing key or a bad name is skipped.

## Safety

This process can type into and stop real terminals, so:

- it binds `127.0.0.1` only, and refuses any request whose `Host` header is not loopback (DNS rebinding);
- every request, including the page, the API and the event stream, needs the per-launch key (as the cookie set from the printed link), so other local users, other websites and anything that merely finds the port get a 401;
- every state-changing request also needs a second per-launch token that only the served page knows, a JSON body, and a same-origin `Origin` when the browser sends one; the key is visible briefly in the arguments of the `open` command when `--open` is used, so on a shared machine paste the printed link instead;
- typed text may not contain control characters (so it cannot press keys the key allow-list refuses);
- stopping needs the lab's name as confirmation in the request, not only a click;
- lab names are validated and every CLI call is an argument array (no shell); only a short list of keys can be pressed;
- the page's content-security policy allows only its own files, with no inline script or style, and screen text is inserted as text, never as HTML;
- no external service is contacted and nothing is sent anywhere. The server only polls the CLI while a page is open (about every 1.5 s) and goes idle 20 s after the last viewer leaves.

## Native clients (phone and desktop)

Loopback stays the default. To let a phone or a native desktop app see the board, opt in:

```
lab-gui --listen <private-address> [--allow-control] [--new-key]
```

This is a separate mode with its own guards: clients send the saved pairing key as `Authorization: Bearer <key>` (cookies and the web page are not served), they are read-only unless `--allow-control` is given, `attach` is never available, and 20 wrong keys lock an address out for a minute. The key lives in a private file (`~/.config/lab-gui/remote-key`, mode 600) so a paired device stays paired; `--new-key` replaces it. The connection is plain HTTP, so use a private network address (a VPN interface) or an SSH tunnel, never a public one. Endpoints, fields and fixtures are in [docs/CLIENT-API.md](docs/CLIENT-API.md).

## Layout

```
server.mjs        entry point: arguments, listen on 127.0.0.1, optional browser open
lib/cli.mjs       the h1 wrapper (list / status / screen / send / key / stop / foreground)
lib/monitor.mjs   builds the snapshot: graph, roles, state, models, activity, token and cost counters
lib/app.mjs       HTTP: static page, JSON API, server-sent events, request guards
lib/themes.mjs    reads themes/<name>/colors.toml
themes/           the colour palettes (Omarchy format)
public/           index.html, style.css, app.js, theme.js (palette -> colours; shared with the tests; no build step)
test/             offline tests against a fake CLI; nothing here starts a lab
```

API (all JSON): `GET /api/labs`, `GET /api/themes`, `GET /api/stream` (server-sent events), `GET /api/labs/:name/screen?tail=N`, `POST /api/labs/:name/{send,key,stop,attach}`.

## Tests

```sh
npm test --prefix packages/lab-gui     # node --test, no network, no labs, no watch mode
```
