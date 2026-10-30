export type Exec = (command: string, args: string[], options: { signal?: AbortSignal; timeout: number }) => Promise<{ code: number; stdout: string; stderr: string }>;
export class WindowsNativeBackend {
  constructor(exec: Exec);
  helper(): Promise<string>;
  run<T>(request: Record<string, unknown>, signal?: AbortSignal, timeout?: number): Promise<T>;
}
