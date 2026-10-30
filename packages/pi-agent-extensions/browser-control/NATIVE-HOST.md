# Brave-first Chromium helper setup

The opt-in MV3 helper lives in `helper-extension/`. Brave is the documented first target. Zen is **not supported or live-verified** for this CDP helper. No browser install, extension install, registry write, or browser restart is performed by package scripts.

## Build and inspect the helper

From the package directory, run `npm run build:min` if you need the packaged `dist/` layout. The unpacked helper source directory is `browser-control/helper-extension/`; its runtime assets and local protocol module are tested in source and built layouts. The helper requests `debugger`, `storage`, `tabs`, and `nativeMessaging` permissions. Inspect those permissions and enable only when you intend to use the helper.

1. Open `brave://extensions`.
2. Enable **Developer mode** and choose **Load unpacked**.
3. Select the absolute `packages/pi-agent-extensions/browser-control/helper-extension` directory.
4. Open the helper popup, explicitly connect to the native host, and grant only intended HTTP(S) page origins/tabs. There is no inferred grant.

## Host and broker

The broker is explicitly operator-started; the installer does not start it. On Windows, after installing/compiling the native executable and registering the manifest as described below:

```powershell
& "$env:LOCALAPPDATA\PiBrowserBridge\bridge-host.exe" --broker --config "$env:LOCALAPPDATA\PiBrowserBridge\host-config.json"
```

The launcher uses two distinct modes. For Chrome/Brave's path-only manifest invocation, it validates the exact extension-origin argv, starts Node `bridge-host.mjs --native --config <config>`, and relays Chrome's raw Native Messaging stdin/stdout to that child; Node retains the Native Messaging translator and validators. It does not connect Chrome frames directly to the broker pipe. The explicitly operator-started `--broker` mode creates the owner/SYSTEM/Administrators DACL pipe, rejects remote clients, requires first-instance creation, and starts one Node `bridge-host.mjs --broker-stdio --config <same-config>` child. Node owns all sessions, grants, target IDs, and routing. Unix/macOS retain the Node owner-only Unix socket transport.

## Safe installer modes and Brave registration

The installer defaults to Brave and has non-writing dry-run plus fixture output modes:

```sh
node browser-control/native-host/install.mjs --dry-run --browser brave --extension-id <EXACT_32_CHAR_BRAVE_EXTENSION_ID>
node browser-control/native-host/install.mjs --install --fixture /tmp/pi-bridge-fixture --browser brave --extension-id <EXACT_32_CHAR_BRAVE_EXTENSION_ID> --pipe-name '\\.\pipe\pi-browser-bridge-0123456789abcdef0123456789abcdef'
node browser-control/native-host/install.mjs --uninstall --fixture /tmp/pi-bridge-fixture --browser brave --pipe-name '\\.\pipe\pi-browser-bridge-0123456789abcdef0123456789abcdef'
```

Windows fixture install compiles the C# launcher locally with .NET Framework `csc.exe` and writes only beneath the fixture directory. It never registers the manifest or touches the registry. For a real install, review dry-run output, then explicitly run `--install --browser brave --extension-id <exact id>`; the installer writes per-user manifest/config files and prints, but does not perform, the registration step.

On Windows, set the default value of this **current-user** key to the printed manifest path:

`HKEY_CURRENT_USER\Software\BraveSoftware\Brave-Browser\NativeMessagingHosts\com.pi_agent_extensions.browser_bridge`

On macOS/Linux, Brave discovers the manifest in its per-user `NativeMessagingHosts` directory. The installer never writes Windows registry keys, launches Brave, or restarts it. Native-host registration changes may require fully exiting and restarting an already-running Brave process; extension source changes require reloading the unpacked extension (and its service worker). Uninstall removes only generated manifest/launcher/config files; Windows registry cleanup is manual.

### Explicit Chrome option

Chrome is supported as an explicit packaging option; there is no silent Chrome-only default. Use `--browser chrome`, load the same unpacked helper through `chrome://extensions`, and register the generated manifest at:

`HKEY_CURRENT_USER\Software\Google\Chrome\NativeMessagingHosts\com.pi_agent_extensions.browser_bridge`

The Chrome key is likewise printed only; package scripts do not write it. Brave remains the default/documented setup.

## MCP tool scope and Windows foreground opt-in

The browser helper/bridge exposes background, page-targeted CDP actions. On Windows, the stdio MCP server also offers the existing foreground controller through the shared Windows backend and action-preparation seam; it does not duplicate the native actuator. These tools are hidden by default. To advertise them, set `PI_BROWSER_MCP_ENABLE_WINDOWS_FOREGROUND=1` in the MCP server process environment.

Even after opt-in, foreground input starts **off on every MCP process launch**. Call `windows_foreground_surface` with `action: "on"` to enable it for that MCP session; use `action: "off"` or `"status"` as needed. Before input, call `windows_foreground_observe` to select/capture an existing Brave/Zen browser window (read-only; it does not focus the window). Then call `windows_foreground_act` for supported click, drag, scroll, type, or key input. Actions require the last observed window to remain active/foreground; foreground actions can interrupt the user. The tool refuses when the observation is stale, the surface is off, or the target window is no longer foreground. It does not retry through the extension/CDP background path or fall back to another input mode. Keep the environment opt-in unset unless this user-visible foreground behavior is explicitly intended.

Zen remains unsupported/live-unverified for the CDP helper. Fixture tests make no live Chromium compatibility claim.
