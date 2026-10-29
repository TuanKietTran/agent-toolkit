export function resolveHome(options?: { userInfo?: () => { homedir: string }; homedir?: () => string }): string;
export function writeAtomic(target: string, contents: string, options?: { fsImpl?: typeof import("node:fs") }): void;
