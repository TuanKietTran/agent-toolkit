// right-panel — shared right-panel registry: tabs, collapse state, /right-panel, and tab switching by click or shortcut.
//
// Other extensions reach the registry through getRightPanel(). The registry lives on globalThis
// under the key the bundled layout patch reads (collapse state), so /right-panel still works.

import { truncateToWidth, type Component, type TuiMouseEvent, type TuiMouseEventResult } from "@earendil-works/pi-tui";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { PI_EVENT } from "./events.ts";

// --- Constants: every local literal lives here. ---

const STATE_KEY = Symbol.for("pi.tui.right-panel.v1");
const WIDGET_KEY = "right-panel-tabs";
const STATUS_KEY = "tui-right-panel-control";
const WIDGET_PLACEMENT = "aboveEditor";
const DEFAULT_TABS = [{ id: "tools", label: "Tools" }] as const;
const DEFAULT_TAB_BODY = [""];
const TAB_SEPARATOR = " ";
const TAB_PADDING = " ";
const TAB_CELL_WIDTH = 10;
const ACCENT = "accent";
const DIM = "dim";
const SHORTCUT_NEXT = "ctrl+alt+n";
const SHORTCUT_PREV = "ctrl+alt+p";
const SHORTCUT_NEXT_DESCRIPTION = "Right panel: next tab";
const SHORTCUT_PREV_DESCRIPTION = "Right panel: previous tab";
const STEP_NEXT = 1;
const STEP_PREV = -1;
const CLICK_TYPES = new Set(["click", "press"]);
const CLICK_BUTTON = "left";
const TAB_ROW = 0;
const COMMAND_NAME = "right-panel";
const COMMAND_DESCRIPTION = "Right panel: toggle, show, hide, auto, or status";
const ACTION_DEFAULT = "toggle";
const ACTION_TOGGLE = "toggle";
const ACTION_SHOW = "show";
const ACTION_AUTO = "auto";
const ACTION_HIDE = "hide";
const ACTION_STATUS = "status";
const USAGE = "Usage: /right-panel [toggle|show|hide|auto|status]";
const NOTE_WARNING = "warning";
const NOTE_INFO = "info";
const MODE_HIDDEN = "hidden";
const MODE_RESPONSIVE = "responsive";
const notifyMode = (mode: string) => `Right panel: ${mode}`;
const notifyTabs = () => `Tabs: ${sortedTabs().map((tab) => tab.label).join(", ") || "none"}`;

export interface RightPanelTab {
	id: string;
	label: string;
	order?: number;
	/** Lines for the tab body. The panel clips each line to the panel width. */
	lines(width: number, ctx: ExtensionContext): string[];
}

export interface RightPanelApi {
	/** Add or replace a tab. Returns a disposer that removes it. */
	registerTab(tab: RightPanelTab): () => void;
	/** Make a tab active and expand the panel. Returns false when no tab has that id. */
	openTab(id: string): boolean;
	/** Move the active tab by `step` (wraps around). Returns false when there are no tabs. */
	cycleTab(step: number): boolean;
	tabs(): readonly RightPanelTab[];
	activeTab(): string | undefined;
	isCollapsed(): boolean;
	setCollapsed(collapsed: boolean): void;
}

type RightPanelState = {
	collapsed: boolean;
	tabs: Map<string, RightPanelTab>;
	active?: string;
};

type RightPanelGlobals = typeof globalThis & { [STATE_KEY]?: RightPanelState };
type Theme = ExtensionContext["ui"]["theme"];
type TabHit = { id: string; start: number; end: number };

const globals = globalThis as RightPanelGlobals;
const state: RightPanelState = (globals[STATE_KEY] ??= { collapsed: false, tabs: new Map() });
state.tabs ??= new Map();

let uiContext: ExtensionContext | undefined;

// Re-render without replacing the mounted widget. Replacing it during a mouse/key event
// can detach the component currently dispatching the event.
function requestLayout(): void {
	uiContext?.ui.setStatus(STATUS_KEY, undefined);
}

const sortedTabs = (): RightPanelTab[] =>
	[...state.tabs.values()].sort((a, b) => (a.order ?? 0) - (b.order ?? 0) || a.id.localeCompare(b.id));

const tabText = (tab: RightPanelTab): string => `${TAB_PADDING}${tab.label}${TAB_PADDING}`.padEnd(TAB_CELL_WIDTH);

/** Clip by visible terminal columns without cutting through ANSI color sequences. */
const clip = (line: string, width: number): string => truncateToWidth(line, width);

/**
 * Tab strip plus the active tab body. Clicking a label on the strip switches tabs.
 * The hit map is rebuilt on every render so clicks always match what is on screen.
 */
function createPanel(theme: Theme): Component {
	let hits: TabHit[] = [];
	return {
		render(width) {
			hits = [];
			const tabs = sortedTabs();
			if (tabs.length === 0) return [];

			let column = 0;
			const cells: string[] = [];
			for (const tab of tabs) {
				const text = tabText(tab);
				const active = tab.id === state.active;
				cells.push(active ? theme.bold(theme.fg(ACCENT, text)) : theme.fg(DIM, text));
				hits.push({ id: tab.id, start: column, end: column + text.length });
				column += text.length + TAB_SEPARATOR.length;
			}

			const active = tabs.find((tab) => tab.id === state.active) ?? tabs[0];
			const body = uiContext ? active.lines(width, uiContext) : [];
			// Tab labels are short and the visible width fits every supported panel width.
			// Do not slice the styled string: ANSI color sequences count toward string.length.
			return [cells.join(TAB_SEPARATOR), ...body.map((line) => clip(line, width))];
		},
		handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
			if (!CLICK_TYPES.has(event.type) || event.button !== CLICK_BUTTON || event.y !== TAB_ROW) return undefined;
			const hit = hits.find((tab) => event.x >= tab.start && event.x < tab.end);
			if (!hit) return undefined;
			api.openTab(hit.id);
			return { handled: true, render: true };
		},
		invalidate() {},
	};
}

/** Mount, update, or remove the tab strip widget. Pi only re-lays out when a widget changes. */
function refreshWidget(): void {
	if (!uiContext) return;
	if (state.tabs.size === 0) {
		uiContext.ui.setWidget(WIDGET_KEY, undefined);
		return;
	}
	uiContext.ui.setWidget(WIDGET_KEY, (_tui, theme) => createPanel(theme), { placement: WIDGET_PLACEMENT });
}

const api: RightPanelApi = {
	registerTab(tab) {
		state.tabs.set(tab.id, tab);
		state.active ??= tab.id;
		refreshWidget();
		return () => {
			if (state.tabs.get(tab.id) !== tab) return;
			state.tabs.delete(tab.id);
			if (state.active === tab.id) state.active = sortedTabs()[0]?.id;
			refreshWidget();
		};
	},
	openTab(id) {
		if (!state.tabs.has(id)) return false;
		state.active = id;
		state.collapsed = false;
		requestLayout();
		return true;
	},
	cycleTab(step) {
		const tabs = sortedTabs();
		if (tabs.length === 0) return false;
		const current = tabs.findIndex((tab) => tab.id === state.active);
		const next = (current + step + tabs.length) % tabs.length;
		return api.openTab(tabs[next].id);
	},
	tabs: () => sortedTabs(),
	activeTab: () => state.active,
	isCollapsed: () => state.collapsed,
	setCollapsed(collapsed) {
		state.collapsed = collapsed;
		requestLayout();
	},
};

/** Public handle for other extensions: register tabs, open tabs, and collapse or show the panel. */
export function getRightPanel(): RightPanelApi {
	return api;
}

export default function rightPanel(pi: ExtensionAPI): void {
	// This module can survive a Pi reload. Never use the previous session's ctx
	// while registering tabs; mounting waits for the next session_start event.
	uiContext = undefined;
	// Every built-in tab has the same one-line body,
	// so changing tabs only changes highlighting and never changes panel height/content flow.
	for (const [order, tab] of DEFAULT_TABS.entries()) {
		api.registerTab({ id: tab.id, label: tab.label, order, lines: () => DEFAULT_TAB_BODY });
	}

	pi.on(PI_EVENT.SESSION_START, async (_event, ctx) => {
		uiContext = ctx;
		refreshWidget();
	});
	pi.on(PI_EVENT.SESSION_SHUTDOWN, async () => {
		uiContext = undefined;
	});

	pi.registerShortcut(SHORTCUT_NEXT, {
		description: SHORTCUT_NEXT_DESCRIPTION,
		handler: async (ctx) => {
			uiContext = ctx;
			api.cycleTab(STEP_NEXT);
		},
	});

	pi.registerShortcut(SHORTCUT_PREV, {
		description: SHORTCUT_PREV_DESCRIPTION,
		handler: async (ctx) => {
			uiContext = ctx;
			api.cycleTab(STEP_PREV);
		},
	});

	pi.registerCommand(COMMAND_NAME, {
		description: COMMAND_DESCRIPTION,
		handler: async (args, ctx) => {
			uiContext = ctx;
			const action = args.trim().toLowerCase() || ACTION_DEFAULT;
			if (action === ACTION_TOGGLE) api.setCollapsed(!state.collapsed);
			else if (action === ACTION_SHOW || action === ACTION_AUTO) api.setCollapsed(false);
			else if (action === ACTION_HIDE) api.setCollapsed(true);
			else if (action !== ACTION_STATUS) {
				ctx.ui.notify(USAGE, NOTE_WARNING);
				return;
			}

			ctx.ui.notify(`${notifyMode(state.collapsed ? MODE_HIDDEN : MODE_RESPONSIVE)} · ${notifyTabs()}`, NOTE_INFO);
		},
	});
}
