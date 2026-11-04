// Electron entry: starts the lab-gui server inside this process (loopback, random port, launch key)
// and shows it in a window. No Node install is needed on the machine, only the agent-cli-lab binary.
import { app, BrowserWindow, Menu, dialog, session, shell } from "electron";
import { existsSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { findLabBinary, labEnv } from "./lib/binary.mjs";
import { WINDOW_OPTIONS, canNavigate, isOwnRequest } from "./lib/policy.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
// Packaged: the server code is staged next to this file. In a checkout it is the sibling package.
const guiRoot = existsSync(path.join(here, "gui", "lib", "serve.mjs")) ? path.join(here, "gui") : path.join(here, "..", "lab-gui");
const smokePath = process.env.LAB_GUI_DESKTOP_SMOKE; // when set: load, take a picture, quit (used by tests and CI)

let gui;
let win;

async function start() {
  const { startGui } = await import(pathToFileURL(path.join(guiRoot, "lib", "serve.mjs")).href);
  const { createCli } = await import(pathToFileURL(path.join(guiRoot, "lib", "cli.mjs")).href);

  const binary = findLabBinary();
  const env = labEnv();
  if (!binary && !smokePath) {
    await dialog.showMessageBox({
      type: "warning",
      message: "agent-cli-lab was not found",
      detail: "Lab Deck reads your labs through the agent-cli-lab command. Install it (cargo install --path packages/agent-cli-lab) or set AGENT_CLI_LAB_BIN to its full path, then restart. The window will open, but stay empty until then.",
    });
  }
  gui = await startGui({ cli: createCli({ bin: binary ?? "agent-cli-lab", env }) });

  // Everything the page loads must come from the local server.
  session.defaultSession.webRequest.onBeforeRequest((details, callback) => callback({ cancel: !isOwnRequest(gui.origin, details.url) }));
  session.defaultSession.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
  session.defaultSession.setPermissionCheckHandler(() => false);

  await openWindow();
  if (smokePath) await smoke();
}

async function openWindow() {
  win = new BrowserWindow({ ...WINDOW_OPTIONS, webPreferences: { ...WINDOW_OPTIONS.webPreferences } });
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  win.webContents.on("will-navigate", (event, url) => {
    if (!canNavigate(gui.origin, url)) event.preventDefault();
  });
  win.once("ready-to-show", () => { if (!smokePath) win?.show(); });
  win.on("closed", () => { win = undefined; });
  await win.loadURL(gui.url);
}

async function smoke() {
  const deadline = Date.now() + 20000;
  let labs = 0;
  while (Date.now() < deadline) {
    labs = await win.webContents.executeJavaScript('document.querySelectorAll(".node, .card").length');
    if (labs > 0) break;
    await new Promise((r) => setTimeout(r, 250));
  }
  await new Promise((r) => setTimeout(r, 1500));
  const image = await win.webContents.capturePage();
  writeFileSync(smokePath, image.toPNG());
  const title = win.getTitle();
  console.log(JSON.stringify({ smoke: true, title, nodes: labs, png: image.toPNG().length }));
  app.exit(labs > 0 ? 0 : 1);
}

function buildMenu() {
  const mac = process.platform === "darwin";
  return Menu.buildFromTemplate([
    ...(mac ? [{ role: "appMenu" }] : []),
    { label: "File", submenu: [mac ? { role: "close" } : { role: "quit" }] },
    { role: "editMenu" },
    { label: "View", submenu: [{ role: "reload" }, { role: "forceReload" }, { type: "separator" }, { role: "resetZoom" }, { role: "zoomIn" }, { role: "zoomOut" }, { type: "separator" }, { role: "togglefullscreen" }] },
    { role: "windowMenu" },
    { label: "Help", submenu: [{ label: "About agent-cli-lab", click: () => shell.openExternal("https://github.com/TuanKietTran/agent-toolkit/tree/main/packages/agent-cli-lab") }] },
  ]);
}

if (smokePath) app.disableHardwareAcceleration();
if (!app.requestSingleInstanceLock() && !smokePath) {
  app.quit();
} else {
  app.on("second-instance", () => { if (win) { if (win.isMinimized()) win.restore(); win.focus(); } });
  app.on("window-all-closed", () => { if (process.platform !== "darwin") app.quit(); });
  app.on("activate", () => { if (!win && gui) openWindow().catch(() => {}); });
  app.on("before-quit", () => { gui?.close(); });
  app.whenReady().then(() => {
    Menu.setApplicationMenu(buildMenu());
    return start();
  }).catch((error) => {
    console.error(`lab-deck: ${error?.stack ?? error}`);
    app.exit(1);
  });
}
