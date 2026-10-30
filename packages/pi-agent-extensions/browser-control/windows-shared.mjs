// Shared Windows browser policy primitives used by Pi and standalone MCP adapters.
export function validatedUrl(value) {
  if (value === "about:blank") return value;
  if (!value) throw new Error("This action requires url");
  const url = new URL(value);
  if (!["http:", "https:"].includes(url.protocol)) throw new Error("Only HTTP(S) and about:blank URLs are allowed");
  if (url.username || url.password) throw new Error("URLs containing credentials are not allowed");
  return url.href;
}
export function windowPoint(view, x, y) {
  if (x === undefined || y === undefined || !Number.isFinite(x) || !Number.isFinite(y)) throw new Error("Finite x and y are required");
  if (x < 0 || y < 0 || x >= view.image_width || y >= view.image_height) throw new Error("Coordinates are outside the latest screenshot");
  return { x: Math.floor(x * view.width / view.image_width), y: Math.floor(y * view.height / view.image_height) };
}
export function assertSameWindow(view, current) {
  if (view.window_id !== current.window_id || view.process_id !== current.process_id || view.browser !== current.browser) throw new Error("Browser window changed; call win_browser_observe again");
  if (view.width !== current.width || view.height !== current.height || current.minimized) throw new Error("Browser window resized or minimized; call win_browser_observe again");
}
export function browserSetting(value) {
  if (!value?.trim()) return undefined;
  const browser = value.trim().toLowerCase();
  if (browser !== "brave" && browser !== "zen") throw new Error("PI_WIN_BROWSER_APP must be brave or zen");
  return browser;
}
export function prepareWindowsAction(view, current, params, { enabled = true, requireForeground = false } = {}) {
  const allowedActions = ["move", "click", "focus_click", "double_click", "right_click", "drag", "scroll", "type", "key"];
  if (!params || !allowedActions.includes(params.action)) throw new Error("Unsupported Windows browser input action");
  if (!enabled) throw new Error("Browser surface input is off; use win_browser_surface on");
  assertSameWindow(view, current);
  if (requireForeground && !current.foreground) throw new Error("Browser is not active; foreground input refused");
  const mode = params.input_mode ?? (requireForeground ? "foreground" : "background");
  if (mode !== "background" && mode !== "foreground") throw new Error("Invalid input_mode");
  if (requireForeground && mode !== "foreground") throw new Error("Explicit foreground mode is required");
  const request = {
    ...params,
    browser: current.browser,
    window_id: current.window_id,
    process_id: current.process_id,
    width: current.width,
    height: current.height,
    expected: true,
    input_mode: mode,
    modifiers: params.modifiers?.join(","),
  };
  if (params.action === "type") {
    if (typeof params.text !== "string") throw new Error("type requires text");
    if (params.text.length > 2048 || params.text.length * ((params.interval_ms ?? 8) + 2) > 20_000) throw new Error("Typing batch exceeds 20 seconds; shorten it or reduce interval_ms");
  } else if (params.action === "key") {
    if (typeof params.key !== "string" || !params.key || params.key.length > 64) throw new Error("key requires a supported key name");
    const modifiers = params.modifiers ?? [];
    if (!Array.isArray(modifiers) || modifiers.length > 3 || new Set(modifiers).size !== modifiers.length || modifiers.some(modifier => !["control", "shift", "alt"].includes(modifier))) throw new Error("Invalid key modifiers");
  } else {
    for (const [name, value] of [["delta_x", params.delta_x], ["delta_y", params.delta_y]]) if (value !== undefined && (!Number.isInteger(value) || Math.abs(value) > 12000)) throw new Error(`${name} must be an integer within +/-12000`);
    for (const [name, value, max] of [["duration_ms", params.duration_ms, 10000], ["interval_ms", params.interval_ms, 1000]]) if (value !== undefined && (!Number.isInteger(value) || value < 0 || value > max)) throw new Error(`${name} is outside the supported range`);
    const point = params.action === "scroll" && params.x === undefined && params.y === undefined
      ? { x: Math.floor(current.width / 2), y: Math.floor(current.height / 2) }
      : windowPoint(current, params.x, params.y);
    Object.assign(request, point);
    if (params.action === "drag") Object.assign(request, { target_x: windowPoint(current, params.target_x, params.target_y).x, target_y: windowPoint(current, params.target_x, params.target_y).y });
  }
  return request;
}
