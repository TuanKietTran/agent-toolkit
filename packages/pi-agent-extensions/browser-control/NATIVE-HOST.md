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

The launcher starts one Node `bridge-host.mjs --broker-stdio --config <same-config>` child. That child owns all bridge sessions, grants, target IDs, and routing. The Windows executable uses a path-only native-host manifest, a protected per-user config, an owner/SYSTEM/Administrators DACL, remote-client rejection, and first-instance pipe creation. Chrome/Brave's extension-origin argv is checked; Chrome Native Messaging frame bytes are relayed without modification. Unix/macOS retain the Node owner-only Unix socket transport.

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

## Tool scope and limitations

The helper dispatches **background page-targeted CDP input only** through the shared browser bridge. MCP exposes this helper/page-dispatch path only. It does not expose the existing Windows foreground input tools. Existing `win_browser_*` PostMessage/SendInput foreground/background capabilities remain Pi tools only; the MCP foreground-tools integration is a known gap, not an implicit fallback. Zen is not supported/live-verified for this CDP helper, and no live Chromium compatibility is claimed by the fixture tests.
