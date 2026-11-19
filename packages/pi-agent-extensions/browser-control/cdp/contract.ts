// Shared contract of the CDP browser-control extension. Types and constants only.
// The controller (controller.ts and its helpers), the pi tools layer (index.ts, tools.ts) and the
// tests all code against this file.

// ---- Layout (all under packages/pi-agent-extensions/browser-control/cdp/) ----
// controller: client.ts (CDP over WebSocket), controller.ts, ownership.ts, detector.ts,
//             guard.ts, pacing.ts, snapshot.ts, launch.ts
// tools:      index.ts (default export), tools.ts, README.md, package.json "pi.extensions" entry
// tests:      fixture/ (pages + server.ts), tests/*.test.ts, package.json "test" script entry

export const TOOL_NAMES = [
  "tabs_list", "tab_open", "tab_close", "navigate", "snapshot", "click",
  "type", "press", "select", "scroll", "upload", "screenshot", "wait_for",
] as const;
export type ToolName = (typeof TOOL_NAMES)[number];

/** Read-only / housekeeping tools: allowed while a STOP is active. All others are action tools. */
export const OBSERVATION_TOOLS: readonly ToolName[] = ["tabs_list", "tab_close", "snapshot", "screenshot"];

// ---- Parameters (every tool except tabs_list/tab_open names its tab by CDP targetId string) ----
export interface ToolParams {
  tabs_list: Record<string, never>;
  tab_open: { url?: string };                                  // default about:blank; waits for the page to load
  tab_close: { tab: string };
  navigate: { tab: string; url: string };                      // http(s) and about:blank only; waits for load
  snapshot: { tab: string };
  click: { tab: string; ref: string; user_confirmed?: boolean };
  /** Replaces the field's content unless `append` is true. Refuses password fields. */
  type: { tab: string; ref: string; text: string; append?: boolean; user_confirmed?: boolean };
  press: { tab: string; key: string; user_confirmed?: boolean };              // "Enter","Tab","Escape","ArrowDown","a",...
  select: { tab: string; ref: string; value: string };         // option value or visible label
  scroll: { tab: string; direction: "up" | "down" | "left" | "right"; amount?: number; ref?: string }; // px, default 600
  upload: { tab: string; ref: string; file: string };          // absolute path of an existing file
  screenshot: { tab: string };
  wait_for: { tab: string; text?: string; ref?: string; gone?: boolean; timeout_ms?: number }; // default 10000, max 30000
}

// ---- Results. Controller methods NEVER throw for expected failures. ----
export type StopReason = "captcha" | "bot_check" | "login_wall" | "rate_limit" | "unusual_traffic";

export type ErrorCode =
  | "not_connected"      // no browser on the debugging port
  | "not_owned"          // tab exists but the calling agent does not own it
  | "no_such_tab"
  | "no_such_ref"        // ref never issued for this tab
  | "stale_ref"          // ref's node is gone; take a new snapshot
  | "invalid_param"
  | "confirm_required"   // submit-type action without user_confirmed
  | "password_field"     // type() into a password input is always refused
  | "navigation_failed"  // the browser could not load the URL (DNS, refused, TLS, aborted, ...)
  | "dialog_open"        // a JavaScript alert/confirm/prompt blocks the page; press Enter (accept) or Escape (dismiss)
  | "aborted"            // the caller's AbortSignal fired; the action was not performed (or was interrupted)
  | "timeout"
  | "cdp_error";

/**
 * Evidence about what an action actually changed, observed after it ran.
 * `verified` is true only when the expected effect was observed (field holds the typed text, the page
 * navigated or changed, the scroll position moved, ...). It is never inferred from "no exception".
 */
export interface Verification {
  verified: boolean;
  evidence: string;
  url?: string;
  title?: string;
  navigated?: boolean;
  httpStatus?: number;
}

export interface OkResult {
  ok: true;
  /** Text for the model. snapshot: the tree; others: one-line outcome plus evidence. */
  text: string;
  /** screenshot only. base64 PNG. */
  image?: { mimeType: "image/png"; data: string };
  /** Small structured extras, e.g. { tab, url, title }. */
  data?: Record<string, unknown>;
  /** Present on every state-changing action. */
  verification?: Verification;
}

export interface StopResult {
  ok: false;
  stop: true;
  reason: StopReason;
  tab: string;
  url: string;
  /** Always starts with "STOP:" and tells the agent to stop acting and hand over to the user. */
  message: string;
}

export interface ErrorResult {
  ok: false;
  stop: false;
  code: ErrorCode;
  message: string;
}

export type ActionResult = OkResult | StopResult | ErrorResult;

/** Live progress emitted while a call runs. Mirrors runtime/events.ts ToolRuntimeEvent structurally. */
export type ControllerProgress =
  | { kind: "computer.action"; action: string; status: "started" | "completed" | "failed"; target?: string; detail?: string }
  | { kind: "computer.observation"; url?: string; title?: string; navigated?: boolean; verified?: boolean; evidence?: string }
  | { kind: "progress"; message: string; progress?: number };

export interface CallOptions {
  /** Aborting stops waits and prevents a queued action from being dispatched. */
  signal?: AbortSignal;
  onProgress?: (event: ControllerProgress) => void;
}

/** snapshot text format, one node per line, 2-space indent per depth:
 *    [e12] button "Save"
 *    [e13] textbox "Email" value="a@b.c"
 *    heading "Title"            <- no ref when the node is not interactive
 *  Refs are "e<N>", allocated per tab from a counter that never resets and are stable
 *  across snapshots while the DOM node (backendNodeId) lives. First line: "# url title".
 *  If the page is blocked (detector), the snapshot starts with "BLOCKED: <reason>". */
export const REF_PATTERN = /^e\d+$/;

// ---- Safety primitives (pure functions, exported from the named files) ----
export interface PageFacts { url: string; title: string; text: string }   // text = visible text, truncated
export interface Detection { blocked: boolean; reason?: StopReason; evidence?: string }
// detector.ts:  export function detectBlock(page: PageFacts): Detection
//   flags captcha / "verify you are human" / cloudflare challenge (bot_check) / sign-in or login wall
//   (password input + login wording, or url /login|signin|accounts) / 429 or "too many requests"
//   (rate_limit) / "unusual traffic" ("unusual_traffic").

export interface ClickTargetFacts { role: string; name: string; inputType?: string; inForm?: boolean; inSearchForm?: boolean }
// guard.ts:  export function isSubmitLike(t: ClickTargetFacts): boolean
//   true for type=submit, and buttons/links named submit, pay, buy, purchase, place order, confirm,
//   send, post, publish, delete, checkout, subscribe, sign up, register, apply (case-insensitive).
//   A plain search form (role=search or containing a search input) is not submit-like unless the
//   control is named for a payment, purchase, deletion or subscription.

// ---- Ownership (ownership.ts) ----
export interface Ownership {
  /** Tab opened by `agent` through tab_open. */
  register(agent: string, tabId: string): void;
  /** User-initiated assignment of an existing tab (slash command only, never a model tool). */
  assign(agent: string, tabId: string): void;
  release(tabId: string): void;
  owner(tabId: string): string | undefined;
  owns(agent: string, tabId: string): boolean;
  list(agent: string): string[];
}
// export function createOwnership(): Ownership

// ---- Pacing (pacing.ts) ----
export interface PacingOptions {
  minDelayMs: number;   // default 150, random delay before each action: uniform in [min,max]
  maxDelayMs: number;   // default 700
  minGapMs: number;     // default 400: minimum time between two actions of the controller
  sleep?: (ms: number) => Promise<void>;   // injectable for tests
  random?: () => number;                   // injectable for tests
}
export const FAST_PACING: PacingOptions = { minDelayMs: 0, maxDelayMs: 0, minGapMs: 0 };
// Actions are serialized by a mutex: one at a time, no parallel input.

// ---- Controller (controller.ts) ----
export interface ControllerOptions {
  host?: string;               // default "127.0.0.1" (loopback only; refuse anything else)
  port?: number;               // default env PI_BC_PORT or 9222
  pacing?: Partial<PacingOptions>;
  ownership?: Ownership;
  /** Upper bound for waiting on a page load after navigate/tab_open/click-navigation. Default 15000. */
  loadTimeoutMs?: number;
}

export interface BlockState { tab: string; url: string; reason: StopReason }

export interface Controller {
  readonly ownership: Ownership;
  /** Attach to the browser on host:port. Idempotent. Returns not_connected error text instead of throwing. */
  connect(): Promise<{ ok: true; browser: string } | ErrorResult>;
  /** Detach websockets. Never closes the user's browser and never closes tabs. */
  close(): Promise<void>;
  /** The active agent-level halt, if any (set when the detector flags a page of an owned tab). */
  halted(): BlockState | undefined;
  /** User action (slash command): clear the halt. */
  resume(): void;
  /** Every method: first arg is the agent id, ownership is enforced before anything else. */
  call<T extends ToolName>(agent: string, tool: T, params: ToolParams[T], opts?: CallOptions): Promise<ActionResult>;
}
// export function createController(opts?: ControllerOptions): Controller
//
// Semantics of call():
//  1. validate params (invalid_param)   2. ensure connected (not_connected)
//  3. tab-targeting tools: tab must exist (no_such_tab) and be owned by `agent` (not_owned);
//     the user's own tabs are never listed, read, or touched. tabs_list lists ONLY owned tabs.
//  4. action tools (not in OBSERVATION_TOOLS): if halted() is set, re-check that tab; if still
//     blocked return StopResult, otherwise clear the halt. Then run detectBlock on the target
//     page before acting; if blocked set the halt and return StopResult. Do nothing else.
//  5. click/press submit guard (isSubmitLike): without user_confirmed return confirm_required.
//  6. pacing: serialize + random delay, then act. Input only through CDP Input.dispatchMouseEvent /
//     dispatchKeyEvent / insertText (no Page.bringToFront, no Target.activateTarget, no OS input).
//     An aborted signal is checked again right before dispatch: a queued action never runs after abort.
//  7. After the action: wait for any navigation it started to load, observe url/title/page text and
//     the target element, and attach a Verification. Then re-run detectBlock; if the new page is
//     blocked set the halt and return StopResult (so the agent learns at once).

// ---- Launch (launch.ts) ----
export interface LaunchOptions { port?: number; profileDir?: string; bravePath?: string }
// export function resolveBravePath(): string | undefined   (env PI_BC_BRAVE, then standard macOS/Linux/Windows paths)
// export function launchBrave(o?: LaunchOptions): Promise<{ pid: number; port: number; profileDir: string }>
//   spawns detached Brave with --remote-debugging-port=PORT --remote-debugging-address=127.0.0.1
//   --user-data-dir=PROFILE (default ~/.pi/browser-control-cdp/profile, persistent so sign-ins stay).
//   Never auto-called by a tool; only by the /bc launch slash command.

// ---- Tools layer (index.ts / tools.ts) ----
// export default function browserControlCdp(pi: ExtensionAPI, deps?: { controller?: Controller; agent?: () => string }): void
// registers the 13 tools named in TOOL_NAMES (exact names), each calling controller.call(agent, name, params,
// { signal, onProgress }). Every tool is registered with executionMode "sequential" so pi never runs two
// browser calls of one assistant message concurrently.
// Agent id: deps.agent?.() ?? process.env.H1_SELF ?? "pi".
// Result mapping: OkResult -> content text (+ image block for screenshot), details = the result;
// StopResult/ErrorResult -> content text = message, details = the result object (do not throw), so the
// agent reads the STOP. Progress -> onUpdate({ content, details: { runtimeEvent } }).
// Slash command /bc: status | launch | assign <tabId> [agent] | resume.
// The controller is created lazily on first use (no browser connection at load time).
