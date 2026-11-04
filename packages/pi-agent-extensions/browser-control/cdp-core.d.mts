export type Point = { x: number; y: number };

export const CDP_ACTIONS: readonly ["move", "click", "double_click", "right_click", "drag", "scroll", "type", "key", "wait", "reset_trail"];
export const CDP_TAB_ACTIONS: readonly ["status", "list_tabs", "open", "new_tab", "select_tab", "close_tab", "back", "forward", "reload"];
export const VIEWPORT: { width: number; height: number };

export function normalizeKey(key: string, modifiers?: readonly string[]): string;
export function validatedUrl(raw: unknown): string;
export function checkPoint(label: string, x: unknown, y: unknown, view: { width: number; height: number }): Point;
export const text: (value: unknown) => [{ type: "text"; text: string }];
export const sleep: (ms: number, signal?: AbortSignal) => Promise<void>;

export class CdpSession {
  trail: Point[];
  readState: Map<any, { errors: unknown[]; dialogs: unknown[] }>;
  trackPage(page: any): void;
  readData(page: any): { errors: any[]; dialogs: any[] };
  constructor(load?: () => Promise<any>);
  get connected(): boolean;
  ensure(): Promise<{ context: any; page: any }>;
  select(page: any): void;
  close(): Promise<void>;
  remember(p: Point): void;
}

export function observePage(session: CdpSession, page: any): Promise<{ image: Buffer; view: { width: number; height: number; url: string; title: string } }>;
export function readPage(session: CdpSession, page: any): Promise<Record<string, unknown>>;
export function perform(session: CdpSession, page: any, view: { width: number; height: number }, params: any, signal?: AbortSignal): Promise<Record<string, unknown>>;
