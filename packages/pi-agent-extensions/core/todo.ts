// todo — persistent human-ordered todo queue: right-panel widget, `todo` tool, /todo command.
//
// The agent adds discovered work and updates status through the tool; the human
// reorders through /todo or Ctrl-Shift-T. With auto-feed on, the agent continues with
// the next open item when a run would otherwise settle. Prompt text and limits live
// in rules.md and contexts.md.

import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, truncateToWidth } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { fill, limits, prompt } from "./md.ts";

type TodoStatus = "pending" | "in_progress" | "done";
type TodoSource = "agent" | "human";

type Todo = {
  id: number;
  text: string;
  status: TodoStatus;
  source: TodoSource;
};

type TodoState = {
  todos: Todo[];
  nextId: number;
  autoFeed: boolean;
};

type TodoToolDetails = TodoState & {
  action: string;
  message: string;
};

interface TodoLimits {
  max_visible_todos: number;
  max_auto_continuations: number;
  max_snapshot_todos: number;
}

import { PI_EVENT } from "./events.ts";

// --- Constants: every local literal lives here. ---

// Identifiers
const STATE_ENTRY = "todo-panel-state";
const WIDGET_KEY = "todo-panel";
const QUEUE_ENTRY = "todo-queue";
const AUTO_FEED_ENTRY = "todo-auto-feed";
export const TOOL_NAME = "todo";
const TOOL_LABEL = "Todo";
const COMMAND_NAME = "todo";
const SHORTCUT_KEY = "t";

// Statuses, sources, tool/command actions
const PENDING = "pending";
const IN_PROGRESS = "in_progress";
const DONE = "done";
const AGENT = "agent";
const HUMAN = "human";
const ACTIONS = ["list", "add", "start", "done", "reopen", "remove", "clear"] as const;
const ACTION_LIST = "list";
const ACTION_ADD = "add";
const ACTION_START = "start";
const ACTION_DONE = "done";
const ACTION_REOPEN = "reopen";
const ACTION_CLEAR = "clear";
const CMD_ADD = "add";
const CMD_MOVE = "move";
const CMD_DONE = "done";
const CMD_REMOVE = "remove";
const CMD_CLEAR_DONE = "clear-done";
const CMD_AUTO = "auto";
const ON = "on";
const OFF = "off";
const ENABLED = "enabled";
const DISABLED = "disabled";
const OUTCOME_COMPLETED = "completed";
const ENTRY_CUSTOM = "custom";
const ENTRY_CUSTOM_MESSAGE = "custom_message";
const MODE_TUI = "tui";
const EMPTY_LISTING = "(empty)";

// Theme colors, icons, keys
const ACCENT = "accent";
const SUCCESS = "success";
const DIM = "dim";
const MUTED = "muted";
const ICON_DONE = "✓";
const ICON_IN_PROGRESS = "▶";
const ICON_PENDING = "○";
const MARKER_SELECTED = "›";
const MARKER_NONE = " ";
const ICON_OPEN = "☑";
const KEY_ESCAPE = "escape";
const KEY_CTRL_C = "ctrl+c";
const KEY_UP = "up";
const KEY_DOWN = "down";
const KEY_DELETE = "delete";
const KEY_QUIT = "q";
const KEY_VI_UP = "k";
const KEY_VI_DOWN = "j";
const KEY_MOVE_UP = "K";
const KEY_MOVE_DOWN = "J";
const KEY_AUTO = "f";
const KEY_CYCLE = " ";
const KEY_REMOVE = "x";

// Widget and overlay layout
const WIDGET_OPTIONS = { placement: "aboveEditor" } as const;
const OVERLAY_OPTIONS = { overlay: true, overlayOptions: { anchor: "right-center", width: "45%", maxHeight: "80%" } } as const;

// Tool schema text. It is resent with every request, so it stays short.
const TOOL_DESCRIPTION = "Shared ordered work queue (only the human orders it). add: text or items. start, done, reopen, remove: id. list. clear: drops done items.";
const COMMAND_DESCRIPTION = "Manage todos: /todo [add|move|done|remove|clear-done|auto]";
const SHORTCUT_DESCRIPTION = "Open todo manager";

// Manager overlay text
const MANAGER_KEYS_HINT = "↑↓/jk select · J/K move · space status · x delete";
const MANAGER_EMPTY = "No todos. Use /todo add <text>.";

// Notifications and errors
const NOTE_WARNING = "warning";
const NOTE_INFO = "info";
const NOTE_TUI_REQUIRED = "The todo manager requires TUI mode";
const USAGE_ADD = "Usage: /todo add <text>";
const USAGE_MOVE = "Usage: /todo move <id> <position>";
const USAGE_ALL = "Usage: /todo [add <text>|move <id> <position>|done <id>|remove <id>|clear-done|auto on|off]";
const ERR_ADD_EMPTY = "todo add requires text or non-empty items";

// Templated text
const managerTitle = (open: number, total: number) => ` Todos ${open}/${total} `;
const managerAuto = (auto: boolean) => `f auto-feed: ${auto ? ON : OFF} · q close`;
const widgetTitle = (open: number, total: number) => `Todos ${open}/${total}`;
const widgetAuto = (auto: boolean) => ` · auto ${auto ? ON : OFF}`;
const widgetMore = (hidden: number) => `  … ${hidden} more · /todo`;
const openStatus = (open: number) => `${ICON_OPEN} ${open}`;
const todoId = (id: number) => `#${id}`;
const listLine = (todo: Todo, index: number) => `${index + 1}. [${todo.status}] #${todo.id} ${todo.text}`;
const queueLine = (todo: Todo) => `#${todo.id} [${todo.status}] ${todo.text}`;
const queueMore = (hidden: number) => `… ${hidden} more open`;
const queueDone = (count: number) => `(+${count} done)`;
const withOpen = (message: string, open: number) => `${message} (${open} open)`;
const pausedNoProgress = (id: number) => `Todo auto-feed paused: #${id} made no queue progress`;
const pausedLimit = (max: number) => `Todo auto-feed paused after ${max} continuations`;
const autoFeedState = (auto: boolean) => `Todo auto-feed ${auto ? ENABLED : DISABLED}`;
const msgAdded = (ids: string) => `Added ${ids}`;
const msgCount = (count: number) => `${count} todo(s)`;
const msgCleared = (count: number) => `Cleared ${count} done todo(s)`;
const msgStarted = (id: number) => `Started #${id}`;
const msgCompleted = (id: number) => `Completed #${id}`;
const msgReopened = (id: number) => `Reopened #${id}`;
const msgRemoved = (id: number) => `Removed #${id}`;
const errNeedsId = (action: string) => `todo ${action} requires id`;
const errNotFound = (id: number | undefined) => `todo #${id} not found`;
const notFoundNote = (raw: string | undefined) => `Todo #${raw ?? "?"} not found`;
const resultText = (message: string, listing: string) => `${message}\n${listing}`;

// Prompts and limits (from rules.md / contexts.md)
const QUEUE_TEMPLATE = prompt("rules.md", "todo-state");
const EMPTY_QUEUE = prompt("rules.md", "todo-empty");
const AUTO_FEED = prompt("rules.md", "todo-auto-feed");
const LIMITS: TodoLimits = {
  max_visible_todos: 14,
  max_auto_continuations: 20,
  max_snapshot_todos: 40,
  ...limits<Partial<TodoLimits>>("contexts.md", "todo"),
};

const TodoParams = Type.Object({
  action: StringEnum(ACTIONS),
  id: Type.Optional(Type.Number()),
  text: Type.Optional(Type.String()),
  items: Type.Optional(Type.Array(Type.String())),
});

function cloneState(state: TodoState): TodoState {
  return {
    todos: state.todos.map((todo) => ({ ...todo })),
    nextId: state.nextId,
    autoFeed: state.autoFeed,
  };
}

function isState(value: unknown): value is TodoState {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<TodoState>;
  return Array.isArray(candidate.todos) && typeof candidate.nextId === "number" && typeof candidate.autoFeed === "boolean";
}

function statusIcon(status: TodoStatus): string {
  if (status === DONE) return ICON_DONE;
  if (status === IN_PROGRESS) return ICON_IN_PROGRESS;
  return ICON_PENDING;
}

function openCount(todos: Todo[]): number {
  return todos.filter((todo) => todo.status !== DONE).length;
}

function nextTodo(todos: Todo[]): Todo | undefined {
  return todos.find((todo) => todo.status === IN_PROGRESS) ?? todos.find((todo) => todo.status === PENDING);
}

function listing(todos: Todo[]): string {
  return todos.map(listLine).join("\n") || EMPTY_LISTING;
}

function renderTodo(theme: Theme, todo: Todo, selected = false): string {
  const marker = selected ? theme.fg(ACCENT, MARKER_SELECTED) : MARKER_NONE;
  const icon = todo.status === DONE
    ? theme.fg(SUCCESS, statusIcon(todo.status))
    : todo.status === IN_PROGRESS
      ? theme.fg(ACCENT, statusIcon(todo.status))
      : theme.fg(DIM, statusIcon(todo.status));
  const text = todo.status === DONE ? theme.fg(DIM, theme.strikethrough(todo.text)) : todo.text;
  return `${marker} ${icon} ${theme.fg(MUTED, todoId(todo.id))} ${text}`;
}

class TodoManager {
  private selected = 0;

  constructor(
    private readonly theme: Theme,
    private readonly getState: () => TodoState,
    private readonly changed: () => void,
    private readonly close: () => void,
    private readonly requestRender: () => void,
  ) {}

  handleInput(data: string): void {
    const state = this.getState();
    const count = state.todos.length;
    const move = (delta: number) => {
      const target = this.selected + delta;
      if (target < 0 || target >= count) return;
      [state.todos[this.selected], state.todos[target]] = [state.todos[target]!, state.todos[this.selected]!];
      this.selected = target;
      this.changed();
    };

    if (matchesKey(data, KEY_ESCAPE) || matchesKey(data, KEY_CTRL_C) || data === KEY_QUIT) {
      this.close();
      return;
    }
    if (matchesKey(data, KEY_UP) || data === KEY_VI_UP) this.selected = Math.max(0, this.selected - 1);
    else if (matchesKey(data, KEY_DOWN) || data === KEY_VI_DOWN) this.selected = Math.min(Math.max(0, count - 1), this.selected + 1);
    else if (data === KEY_MOVE_UP) move(-1);
    else if (data === KEY_MOVE_DOWN) move(1);
    else if (data === KEY_AUTO) {
      state.autoFeed = !state.autoFeed;
      this.changed();
    } else if (data === KEY_CYCLE && state.todos[this.selected]) {
      const todo = state.todos[this.selected]!;
      todo.status = todo.status === PENDING ? IN_PROGRESS : todo.status === IN_PROGRESS ? DONE : PENDING;
      this.changed();
    } else if ((data === KEY_REMOVE || matchesKey(data, KEY_DELETE)) && state.todos[this.selected]) {
      state.todos.splice(this.selected, 1);
      this.selected = Math.max(0, Math.min(this.selected, state.todos.length - 1));
      this.changed();
    } else return;

    this.requestRender();
  }

  render(width: number): string[] {
    const state = this.getState();
    const lines = [
      this.theme.fg(ACCENT, this.theme.bold(managerTitle(openCount(state.todos), state.todos.length))),
      this.theme.fg(DIM, MANAGER_KEYS_HINT),
      this.theme.fg(DIM, managerAuto(state.autoFeed)),
      "",
    ];
    if (state.todos.length === 0) lines.push(this.theme.fg(DIM, MANAGER_EMPTY));
    else state.todos.forEach((todo, index) => lines.push(renderTodo(this.theme, todo, index === this.selected)));
    return lines.map((line) => truncateToWidth(line, width));
  }

  invalidate(): void {}
}

export default function todo(pi: ExtensionAPI): void {
  let state: TodoState = { todos: [], nextId: 1, autoFeed: true };
  let autoContinuations = 0;
  let stateRevision = 0;
  let lastAutoTodoId: number | undefined;
  let lastAutoRevision = -1;
  // What the model was last shown of the queue. It is shown again only when this
  // differs, so idle prompts add nothing and the cached prompt prefix stays append-only.
  let seenQueue: string | undefined;

  function queueSnapshot(): string {
    const open = state.todos.filter((item) => item.status !== DONE);
    if (open.length === 0) return EMPTY_QUEUE;
    const lines = open.slice(0, LIMITS.max_snapshot_todos).map(queueLine);
    if (lines.length < open.length) lines.push(queueMore(open.length - lines.length));
    const done = state.todos.length - open.length;
    if (done > 0) lines.push(queueDone(done));
    return fill(QUEUE_TEMPLATE, { open: open.length, auto: state.autoFeed ? ON : OFF, queue: lines.join("\n") });
  }

  // A model that was never shown a queue assumes there is none.
  const modelSeesQueue = () => queueSnapshot() === (seenQueue ?? EMPTY_QUEUE);

  function persist(): void {
    stateRevision++;
    pi.appendEntry(STATE_ENTRY, cloneState(state));
  }

  function publish(ctx: ExtensionContext): void {
    const open = openCount(state.todos);
    if (state.todos.length === 0) {
      ctx.ui.setWidget(WIDGET_KEY, undefined);
      ctx.ui.setStatus(WIDGET_KEY, undefined);
      return;
    }

    const visible = state.todos.slice(0, LIMITS.max_visible_todos);
    const lines = [
      ctx.ui.theme.fg(ACCENT, ctx.ui.theme.bold(widgetTitle(open, state.todos.length))) +
        ctx.ui.theme.fg(DIM, widgetAuto(state.autoFeed)),
      ...visible.map((item) => renderTodo(ctx.ui.theme, item)),
    ];
    if (visible.length < state.todos.length) {
      lines.push(ctx.ui.theme.fg(DIM, widgetMore(state.todos.length - visible.length)));
    }
    ctx.ui.setWidget(WIDGET_KEY, lines, WIDGET_OPTIONS);
    ctx.ui.setStatus(WIDGET_KEY, ctx.ui.theme.fg(open > 0 ? ACCENT : SUCCESS, openStatus(open)));
  }

  function saveAndPublish(ctx: ExtensionContext): void {
    persist();
    publish(ctx);
  }

  // A fully completed queue is stale context for the next request; drop it.
  function clearIfAllDone(ctx: ExtensionContext): void {
    if (state.todos.length === 0 || state.todos.some((item) => item.status !== DONE)) return;
    state.todos = [];
    saveAndPublish(ctx);
  }

  function restore(ctx: ExtensionContext): void {
    state = { todos: [], nextId: 1, autoFeed: true };
    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type !== ENTRY_CUSTOM || entry.customType !== STATE_ENTRY || !isState(entry.data)) continue;
      state = cloneState(entry.data);
    }
    autoContinuations = 0;
    stateRevision = 0;
    lastAutoTodoId = undefined;
    lastAutoRevision = -1;
    seenQueue = undefined;
    publish(ctx);
  }

  function addTodos(texts: string[], source: TodoSource): Todo[] {
    const added: Todo[] = [];
    for (const raw of texts) {
      const text = raw.trim();
      if (!text) continue;
      const item: Todo = { id: state.nextId++, text, status: PENDING, source };
      state.todos.push(item);
      added.push(item);
    }
    return added;
  }

  async function openManager(ctx: ExtensionContext): Promise<void> {
    if (ctx.mode !== MODE_TUI) {
      ctx.ui.notify(NOTE_TUI_REQUIRED, NOTE_WARNING);
      return;
    }
    await ctx.ui.custom<void>(
      (tui, theme, _keybindings, done) => new TodoManager(
        theme,
        () => state,
        () => saveAndPublish(ctx),
        () => done(),
        () => tui.requestRender(),
      ),
      OVERLAY_OPTIONS,
    );
  }

  pi.on(PI_EVENT.SESSION_START, async (_event, ctx) => restore(ctx));
  pi.on(PI_EVENT.SESSION_TREE, async (_event, ctx) => restore(ctx));

  // The summary replaces the history that held the last snapshot, so show the queue again.
  pi.on(PI_EVENT.SESSION_COMPACT, async () => {
    seenQueue = undefined;
  });

  // The workflow rules live in the system prompt (core/index.ts). Only a queue the
  // model has not seen goes into the history, and it is persisted there, so keep it short.
  pi.on(PI_EVENT.BEFORE_AGENT_START, async (_event, ctx) => {
    clearIfAllDone(ctx);
    if (modelSeesQueue()) return;
    seenQueue = queueSnapshot();
    return { message: { customType: QUEUE_ENTRY, display: false, content: seenQueue } };
  });

  pi.on(PI_EVENT.AGENT_START, async () => {
    autoContinuations = 0;
  });

  pi.on(PI_EVENT.AGENT_SETTLED, async (_event, ctx) => {
    lastAutoTodoId = undefined;
    lastAutoRevision = -1;
    clearIfAllDone(ctx);
  });

  pi.on(PI_EVENT.AGENT_BEFORE_SETTLE, async (event, ctx) => {
    publish(ctx);
    if (!AUTO_FEED || !state.autoFeed || event.outcome !== OUTCOME_COMPLETED || !event.context.canContinue) return;
    const next = nextTodo(state.todos);
    if (!next) return;
    if (lastAutoTodoId === next.id && lastAutoRevision === stateRevision) {
      ctx.ui.notify(pausedNoProgress(next.id), NOTE_WARNING);
      return;
    }
    if (autoContinuations >= LIMITS.max_auto_continuations) {
      ctx.ui.notify(pausedLimit(LIMITS.max_auto_continuations), NOTE_WARNING);
      return;
    }
    autoContinuations++;
    lastAutoTodoId = next.id;
    lastAutoRevision = stateRevision;
    return {
      entries: [{
        type: ENTRY_CUSTOM_MESSAGE,
        customType: AUTO_FEED_ENTRY,
        display: false,
        content: fill(AUTO_FEED, { id: next.id, text: next.text }),
      }],
      continue: true,
    };
  });

  pi.registerTool({
    name: TOOL_NAME,
    label: TOOL_LABEL,
    description: TOOL_DESCRIPTION,
    parameters: TodoParams,
    executionMode: "sequential",
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      // The model knows its own changes from this result; a human edit it has not been shown stays pending.
      const inSync = modelSeesQueue();
      let message = "";
      if (params.action === ACTION_ADD) {
        const added = addTodos([...(params.items ?? []), ...(params.text ? [params.text] : [])], AGENT);
        if (added.length === 0) throw new Error(ERR_ADD_EMPTY);
        message = msgAdded(added.map((item) => todoId(item.id)).join(", "));
      } else if (params.action === ACTION_LIST) {
        message = msgCount(state.todos.length);
      } else if (params.action === ACTION_CLEAR) {
        const before = state.todos.length;
        state.todos = state.todos.filter((item) => item.status !== DONE);
        message = msgCleared(before - state.todos.length);
      } else {
        if (params.id === undefined) throw new Error(errNeedsId(params.action));
        const index = state.todos.findIndex((item) => item.id === params.id);
        if (index < 0) throw new Error(errNotFound(params.id));
        const item = state.todos[index]!;
        if (params.action === ACTION_START) {
          item.status = IN_PROGRESS;
          message = msgStarted(item.id);
        } else if (params.action === ACTION_DONE) {
          item.status = DONE;
          message = msgCompleted(item.id);
        } else if (params.action === ACTION_REOPEN) {
          item.status = PENDING;
          message = msgReopened(item.id);
        } else {
          state.todos.splice(index, 1);
          message = msgRemoved(item.id);
        }
      }
      if (inSync || params.action === ACTION_LIST) seenQueue = queueSnapshot();
      saveAndPublish(ctx);
      // Every result is resent with all later requests: list returns the queue, the rest only what changed.
      const text = params.action === ACTION_LIST ? resultText(message, listing(state.todos)) : withOpen(message, openCount(state.todos));
      return {
        content: [{ type: "text", text }],
        details: { ...cloneState(state), action: params.action, message } satisfies TodoToolDetails,
      };
    },
  });

  pi.registerCommand(COMMAND_NAME, {
    description: COMMAND_DESCRIPTION,
    handler: async (args, ctx) => {
      const input = args.trim();
      if (!input) {
        await openManager(ctx);
        return;
      }
      const [action = "", ...rest] = input.split(/\s+/);
      if (action === CMD_ADD) {
        const added = addTodos([rest.join(" ")], HUMAN);
        if (added.length === 0) ctx.ui.notify(USAGE_ADD, NOTE_WARNING);
        else saveAndPublish(ctx);
        return;
      }
      if (action === CMD_MOVE) {
        const id = Number(rest[0]);
        const position = Number(rest[1]);
        const from = state.todos.findIndex((item) => item.id === id);
        if (from < 0 || !Number.isInteger(position) || position < 1 || position > state.todos.length) {
          ctx.ui.notify(USAGE_MOVE, NOTE_WARNING);
          return;
        }
        const [moved] = state.todos.splice(from, 1);
        state.todos.splice(position - 1, 0, moved!);
        saveAndPublish(ctx);
        return;
      }
      if (action === CMD_DONE || action === CMD_REMOVE) {
        const id = Number(rest[0]);
        const index = state.todos.findIndex((item) => item.id === id);
        if (index < 0) {
          ctx.ui.notify(notFoundNote(rest[0]), NOTE_WARNING);
          return;
        }
        if (action === CMD_DONE) state.todos[index]!.status = DONE;
        else state.todos.splice(index, 1);
        saveAndPublish(ctx);
        return;
      }
      if (action === CMD_CLEAR_DONE) {
        state.todos = state.todos.filter((item) => item.status !== DONE);
        saveAndPublish(ctx);
        return;
      }
      if (action === CMD_AUTO) {
        const setting = rest[0]?.toLowerCase();
        state.autoFeed = setting === ON ? true : setting === OFF ? false : !state.autoFeed;
        saveAndPublish(ctx);
        ctx.ui.notify(autoFeedState(state.autoFeed), NOTE_INFO);
        return;
      }
      ctx.ui.notify(USAGE_ALL, NOTE_WARNING);
    },
  });

  pi.registerShortcut(Key.ctrlShift(SHORTCUT_KEY), {
    description: SHORTCUT_DESCRIPTION,
    handler: openManager,
  });
}
