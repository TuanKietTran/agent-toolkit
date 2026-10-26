function clean(value) {
  return String(value == null ? "" : value).replace(/[\t\r\n]+/g, " ");
}

function pause(seconds) {
  delay(seconds);
}

// Apple Events against a just-launched or busy browser fail transiently, so poll instead of assuming state.
function waitFor(check, seconds) {
  const deadline = Date.now() + seconds * 1000;
  while (Date.now() < deadline) {
    try { if (check()) return true; } catch (error) {}
    pause(0.1);
  }
  try { return Boolean(check()); } catch (error) { return false; }
}

function frontTab(browser) {
  const windows = browser.windows();
  return windows.length ? windows[0].activeTab() : null;
}

function describe(tab) {
  return tab ? `title=${clean(tab.title())}\nurl=${tab.url()}` : "tab=none";
}

function waitForLoad(browser) {
  pause(0.3);
  waitFor(() => !frontTab(browser).loading(), 10);
}

function requireIndexes(argv) {
  const windowIndex = Number(argv[2]);
  const tabIndex = Number(argv[3]);
  if (!Number.isInteger(windowIndex) || windowIndex < 1 || !Number.isInteger(tabIndex) || tabIndex < 1) {
    throw new Error("window_index and tab_index must be positive integers");
  }
  return { windowIndex: windowIndex - 1, tabIndex: tabIndex - 1 };
}

function activate(browser) {
  browser.activate();
  waitFor(() => browser.frontmost(), 3);
  if (!waitFor(() => browser.windows().length > 0, 1)) {
    try { browser.Window().make(); } catch (error) {}
    waitFor(() => browser.windows().length > 0, 3);
  }
}

function run(argv) {
  if (argv.length < 2) throw new Error("Expected browser application name and action");
  const browserName = argv[0];
  const action = argv[1];
  const browser = Application(browserName);

  if (action === "status") {
    if (!browser.running()) return "running=false";
    const windows = browser.windows();
    if (!windows.length) return "running=true\nwindows=0";
    return `running=true\nwindows=${windows.length}\n${describe(frontTab(browser))}`;
  }

  if (action === "activate") {
    activate(browser);
    return `activated=${browser.frontmost()}\nwindows=${browser.windows().length}`;
  }

  if (action === "window-state") {
    if (!browser.running()) return JSON.stringify({ running: false, windows: 0, minimized: false });
    const windows = browser.windows();
    return JSON.stringify({ running: true, windows: windows.length, minimized: windows.length ? windows[0].minimized() : false });
  }

  if (action === "set-minimized") {
    const windows = browser.windows();
    if (!windows.length) throw new Error("Browser has no window");
    windows[0].minimized = argv[2] === "true";
    waitFor(() => windows[0].minimized() === (argv[2] === "true"), 2);
    return `minimized=${windows[0].minimized()}`;
  }

  if (action === "open") {
    const target = argv[2];
    const windows = browser.windows();
    if (windows.length) frontTab(browser).url = target;
    else browser.openLocation(target);
    waitFor(() => browser.windows().length > 0, 5);
    waitForLoad(browser);
    return describe(frontTab(browser));
  }

  if (action === "new-tab") {
    const target = argv[2];
    const windows = browser.windows();
    if (!windows.length) {
      browser.openLocation(target);
      waitFor(() => browser.windows().length > 0, 5);
    } else {
      const window = windows[0];
      window.tabs.push(browser.Tab({ url: target }));
      window.activeTabIndex = window.tabs().length;
    }
    waitForLoad(browser);
    return describe(frontTab(browser));
  }

  if (action === "list-tabs") {
    if (!browser.running()) return "running=false";
    const windows = browser.windows();
    const lines = [];
    windows.forEach((window, windowIndex) => {
      const active = window.activeTabIndex();
      window.tabs().forEach((tab, tabIndex) => {
        const marker = windowIndex === 0 && tabIndex + 1 === active ? "*" : " ";
        lines.push(`${marker}\t${windowIndex + 1}\t${tabIndex + 1}\t${clean(tab.title())}\t${tab.url()}`);
      });
    });
    return lines.length ? lines.join("\n") : "tabs=0";
  }

  if (action === "select-tab") {
    const indexes = requireIndexes(argv);
    const windows = browser.windows();
    if (!windows[indexes.windowIndex]) throw new Error("Unknown browser window index");
    const window = windows[indexes.windowIndex];
    if (!window.tabs()[indexes.tabIndex]) throw new Error("Unknown browser tab index");
    window.activeTabIndex = indexes.tabIndex + 1;
    // Selecting a tab in a non-front window must also raise that window; otherwise
    // CGWindow capture and PID-routed input can remain attached to another window.
    try { window.index = 1; } catch (error) {}
    browser.activate();
    waitFor(() => browser.frontmost(), 3);
    return describe(window.activeTab());
  }

  if (action === "close-tab") {
    const indexes = requireIndexes(argv);
    const windows = browser.windows();
    if (!windows[indexes.windowIndex]) throw new Error("Unknown browser window index");
    const tabs = windows[indexes.windowIndex].tabs();
    if (!tabs[indexes.tabIndex]) throw new Error("Unknown browser tab index");
    tabs[indexes.tabIndex].close();
    return "closed=true";
  }

  throw new Error(`Unknown browser action: ${action}`);
}
