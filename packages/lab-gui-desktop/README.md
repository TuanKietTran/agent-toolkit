# lab-gui-desktop

The lab board (`packages/lab-gui`) as a desktop app for **macOS** and **Windows**: an Electron window with the GUI server running inside it. Nothing to install except the `agent-cli-lab` command it reads your labs through.

- No Node needed on the machine: the app carries its own runtime and starts the server itself, on `127.0.0.1` with a random port and a fresh launch key each time.
- It looks for `agent-cli-lab` on `PATH` and then in the places a Finder or Start-menu launch does not see (`~/.local/bin`, `~/.cargo/bin`, `/opt/homebrew/bin`, `/usr/local/bin`; on Windows `%USERPROFILE%\.cargo\bin` and `%LOCALAPPDATA%\Programs\agent-cli-lab`). `AGENT_CLI_LAB_BIN` names it explicitly; `AGENT_CLI_LAB_DIR` picks which labs are shown. If it is missing the app says so and opens empty.
- Same screen as the browser version: graph, live state, peek, message, stop with confirmation, attach in a terminal window, themes (`t`).
- The window is sandboxed (no Node, context isolation, no DevTools); requests to anything but the local server are cancelled; it cannot open other windows or ask for camera, microphone or location.

## Run and build

```sh
cd packages/lab-gui-desktop
npm ci
npm start                          # run from the checkout (uses ../lab-gui)
npm test                           # unit tests, no Electron needed
node scripts/package.mjs           # package for this platform into out/
node scripts/package.mjs win32 x64 # cross-build Windows from macOS (works; not code signed)
node scripts/smoke.mjs ["path to the packaged app executable"]
```

`smoke.mjs` opens two throwaway labs in a temporary directory, starts the app (hidden), waits for it to draw them, saves a screenshot of the window, quits and stops the labs. CI (`.github/workflows/desktop.yml`) runs the tests, packages both platforms, smoke-tests each packaged app on its own OS and keeps the unsigned apps as workflow artifacts.

The apps are **not code signed or notarized**. On macOS the first launch may need right-click, Open (or `xattr -dr com.apple.quarantine "Lab Deck.app"`); Windows SmartScreen may ask to confirm.

`npm audit` reports advisories in the packaging tools' own dependencies (`glob` via `@electron/packager`); they run only at build time and are not part of the app.

## Layout

```
main.mjs          Electron entry: server, window, menu, single instance
lib/binary.mjs    finds agent-cli-lab; widens PATH for what it starts
lib/policy.mjs    what the window may load or navigate to; window options
scripts/          stage (collect files), package (electron packager), smoke
test/             unit tests (binary lookup, policy, staged contents)
```

Android (Kotlin) and iOS clients are candidates, not started: the server deliberately listens on loopback only, so a phone app would need a safe way to reach it (an SSH or VPN tunnel, or a small authenticated relay) before a WebView client makes sense. From a phone today, the page works in a mobile browser when the machine's port is forwarded to it.
