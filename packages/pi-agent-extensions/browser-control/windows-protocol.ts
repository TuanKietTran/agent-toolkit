export { assertSameWindow, browserSetting, validatedUrl, windowPoint } from "./windows-shared.mjs";
import type { WindowInfo, WindowsView } from "./windows-shared.mjs";
export type Browser = "brave" | "zen";
export type { WindowInfo, WindowsView };
export type Point = { x: number; y: number };
