import { WindowsNativeBackend } from "./windows-backend.mjs";

export type Exec = (command: string, args: string[], options: { signal?: AbortSignal; timeout: number }) => Promise<{ code: number; stdout: string; stderr: string }>;

/** Pi adapter over the shared backend; Pi exec semantics remain unchanged. */
export class WindowsNative extends WindowsNativeBackend {
  constructor(exec: Exec) { super(exec); }
}
