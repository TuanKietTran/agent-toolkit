export const STATE_DIR: string;
export const JSON_PATH: string;
export const TEXT_PATH: string;
export function render(state: any): string;
export function createFetchers(options?: {
  readClaudeCredential?: () => string | null | Promise<string | null>;
  readCodexCredential?: () => { token: string; accountId?: string | null } | null | Promise<{ token: string; accountId?: string | null } | null>;
  fetchJsonFn?: (url: string, headers: Record<string, string>) => Promise<any>;
}): {
  fetchClaude: () => Promise<any>;
  fetchCodex: () => Promise<any>;
};
export function readPublished(): any;
export function refresh(options?: { force?: boolean; fetchClaudeFn?: () => Promise<any>; fetchCodexFn?: () => Promise<any> }): Promise<any>;
export function main(argv?: string[]): Promise<void>;
