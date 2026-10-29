// Shared validation and coordinate contract; deliberately independent of Pi and Win32.
export type Browser = "brave" | "zen";
export type WindowInfo = {
  window_id: string; process_id: number; browser: Browser; title: string;
  width: number; height: number; x: number; y: number; minimized: boolean; foreground: boolean;
};
export type WindowsView = WindowInfo & { image_width: number; image_height: number };
export type Point = { x: number; y: number };

export function validatedUrl(value: string | undefined): string {
  if (value === "about:blank") return value;
  if (!value) throw new Error("This action requires url");
  const url = new URL(value);
  if (!["http:", "https:"].includes(url.protocol)) throw new Error("Only HTTP(S) and about:blank URLs are allowed");
  if (url.username || url.password) throw new Error("URLs containing credentials are not allowed");
  return url.href;
}

export function windowPoint(view: WindowsView, x: number | undefined, y: number | undefined): Point {
  if (x === undefined || y === undefined || !Number.isFinite(x) || !Number.isFinite(y)) throw new Error("Finite x and y are required");
  if (x < 0 || y < 0 || x >= view.image_width || y >= view.image_height) throw new Error("Coordinates are outside the latest screenshot");
  return { x: Math.floor(x * view.width / view.image_width), y: Math.floor(y * view.height / view.image_height) };
}

export function assertSameWindow(view: WindowsView, current: WindowInfo): void {
  if (view.window_id !== current.window_id || view.process_id !== current.process_id || view.browser !== current.browser) throw new Error("Browser window changed; call win_browser_observe again");
  if (view.width !== current.width || view.height !== current.height || current.minimized) throw new Error("Browser window resized or minimized; call win_browser_observe again");
}

export function browserSetting(value: string | undefined): Browser | undefined {
  if (!value?.trim()) return undefined;
  const browser = value.trim().toLowerCase();
  if (browser !== "brave" && browser !== "zen") throw new Error("PI_WIN_BROWSER_APP must be brave or zen");
  return browser;
}
