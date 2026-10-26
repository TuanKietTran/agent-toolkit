# Pi TUI layout

This directory owns local modifications to Pi's built-in terminal layout.

## Right-side metadata

`install-layout.mjs` makes the right panel the standard home for persistent TUI metadata. It preserves Pi's public `ctx.ui` mounting API and assigns its positions consistently:

1. **Topmost:** Pi's **Tools**, **Running**, and **Pending chats** block.
2. **Middle:** extension widgets mounted with `ctx.ui.setWidget(..., { placement: "aboveEditor" })`. This region receives the flexible height.
3. **Bottommost:** widgets mounted with `placement: "belowEditor"`, then extension statuses, pending chat messages, and Pi's footer. Pending messages stay in the right panel instead of the chat column.

The editor remains in the main chat column. Extensions should use `setWidget` and `setStatus` rather than reaching into Pi's viewport internals; the layout patch decides where those standard mounts render.

## Responsive and collapsible panel

The panel automatically selects a width from the terminal width:

| Terminal columns | Panel columns |
|---:|---:|
| 150+ | 52 |
| 120–149 | 44 |
| 92–119 | 36 |
| 72–91 | 28 |
| below 72 | hidden |

Use the bundled command to override visibility for the current Pi process:

```text
/right-panel              # toggle
/right-panel hide
/right-panel show          # responsive sizing resumes
/right-panel status
```

Pi does not currently expose the fullscreen viewport layout through the extension API, so the column reassignment itself cannot be implemented as a normal `ctx.ui` extension. The installer applies a narrow, idempotent patch to both Pi's readable distribution module and the executable bundle. It fails rather than guessing if an upgrade changes the relevant layout.

Run after installing or upgrading Pi:

```sh
cd ~/Downloads/pi-agent-extensions
npm run install:tui
```

Restart Pi afterward. To target a nonstandard installation:

```sh
PI_PACKAGE_DIR=/path/to/@earendil-works/pi-coding-agent npm run install:tui
```
