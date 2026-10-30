# Chromium helper native host (opt-in)

The MV3 helper is at `helper-extension/`. The production host is `native-host/bridge-host.mjs` (Node.js >=20). The broker and Chrome Native Messaging endpoint are separate modes of that same implementation:

```sh
node /absolute/path/to/browser-control/native-host/bridge-host.mjs --broker
```

Start the broker explicitly before using the helper. Windows native-host packaging is ready, but the transport's broker currently fails closed on Windows until its current-user named-pipe DACL relay is integrated; do not treat the Windows bridge as operational before that blocker is closed. The Windows manifest `path` is the compiled `native-host/bridge-launcher.exe` and has no `args` property. Chrome launches it with the extension origin argument; the tiny .NET Framework launcher loads owner-only `%LOCALAPPDATA%/PiBrowserBridge/host-config.json` (`nodeExecutable`, `hostScript`, `socketPath`), validates ownership/allowed paths, and relays raw stdin/stdout to `node <bridge-host.mjs> --native`. Unix/macOS uses a generated executable shell launcher which execs Node with the same script and mode. The broker is not automatically started by the installer. The runtime endpoint is deterministic per user (Windows named pipe derived from current-user SID; Unix/macOS `${XDG_RUNTIME_DIR:-/tmp}/pi-browser-bridge-<uid>.sock`) and does not depend on environment inherited by Chrome. `PI_BROWSER_BRIDGE_SOCKET` is an optional override for isolated tests and explicitly configured deployments.

Generate the manifest without changing the machine:

```sh
node native-host/install.mjs --dry-run --extension-id <EXACT_32_CHAR_CHROME_EXTENSION_ID>
```

Fixture output only (safe for packaging tests; on Windows this compiles the launcher locally with .NET Framework `csc.exe` and writes only under the fixture directory):

```sh
node native-host/install.mjs --install --fixture /tmp/pi-bridge-fixture --extension-id <EXACT_32_CHAR_CHROME_EXTENSION_ID>
node native-host/install.mjs --uninstall --fixture /tmp/pi-bridge-fixture
```

No extension ID is guessed. For a real install, use `--install --extension-id <exact-id>` after reviewing the generated manifest. Unix/macOS writes the per-user Chrome `NativeMessagingHosts` manifest location. On Windows the script compiles the small C# launcher, writes owner-only config/install directories, and writes the per-user manifest file only. It prints the exact registry key requiring separate, manual opt-in; it never runs `reg`, writes the registry, changes browser installation, or restarts a browser. `--uninstall` removes generated manifest/launcher/config only; on Windows registry cleanup is manual. Do not use a placeholder ID for real registration.

The helper needs the `debugger`, `storage`, and `tabs` permissions. Install/enable the unpacked helper explicitly, inspect its requested permissions, and grant access only to intended tabs/sites in its UI. Chrome must be restarted after native-host registration changes where required by the browser; reload/restart the helper service worker after replacing extension files. Already-running browser processes may cache native-host registration, so restarting Chrome may be necessary before the host is discovered. Start/restart the broker separately in the operator's terminal. Native browser input remains experimental; no live browser validation is claimed here.
