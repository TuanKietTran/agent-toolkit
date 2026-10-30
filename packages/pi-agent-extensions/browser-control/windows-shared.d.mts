export type WindowInfo = { window_id: string; process_id: number; browser: "brave" | "zen"; title: string; width: number; height: number; x: number; y: number; minimized: boolean; foreground: boolean };
export type WindowsView = WindowInfo & { image_width: number; image_height: number };
export function validatedUrl(value: string | undefined): string;
export function windowPoint(view: WindowsView, x: number | undefined, y: number | undefined): { x: number; y: number };
export function assertSameWindow(view: WindowsView, current: WindowInfo): void;
export function browserSetting(value: string | undefined): "brave" | "zen" | undefined;
export function prepareWindowsAction(view: WindowsView, current: WindowInfo, params: Record<string, any>, options?: { enabled?: boolean; requireForeground?: boolean }): Record<string, any>;
