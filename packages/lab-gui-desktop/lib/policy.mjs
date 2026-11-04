// What the window may load and do. The page talks only to the local server; nothing else is
// reachable from it, and it cannot open other windows or ask for device permissions.

/** True when `url` belongs to the app's own origin, or is an inline data: image the page makes itself. */
export function isOwnRequest(origin, url) {
  try {
    const u = new URL(url);
    if (u.protocol === "data:") return true;
    if (u.protocol === "devtools:" || u.protocol === "chrome-extension:") return false;
    return u.origin === origin;
  } catch {
    return false;
  }
}

/** Navigation inside the window: the app's own pages only. */
export const canNavigate = (origin, url) => {
  try {
    return new URL(url).origin === origin;
  } catch {
    return false;
  }
};

export const WINDOW_OPTIONS = {
  width: 1280,
  height: 820,
  minWidth: 360,
  minHeight: 520,
  title: "Lab Deck",
  show: false,
  backgroundColor: "#0e1116",
  webPreferences: {
    contextIsolation: true,
    nodeIntegration: false,
    sandbox: true,
    webSecurity: true,
    spellcheck: false,
    devTools: false,
  },
};
