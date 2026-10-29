import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** Resolve the usage home; PI_USAGE_HOME is a test/sandbox-only override. */
export function resolveHome({ userInfo = os.userInfo, homedir = os.homedir } = {}) {
  if (process.env.PI_USAGE_HOME) return path.resolve(process.env.PI_USAGE_HOME);
  try {
    const home = userInfo().homedir;
    if (home) return home;
  } catch {}
  return homedir();
}

/** Atomically replace a file using a private, same-directory temporary file. */
export function writeAtomic(target, contents, { fsImpl = fs } = {}) {
  fsImpl.mkdirSync(path.dirname(target), { recursive: true });
  const tmp = path.join(
    path.dirname(target),
    `.${path.basename(target)}.tmp.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}`,
  );
  try {
    fsImpl.writeFileSync(tmp, contents, { mode: 0o600, flag: "wx" });
    fsImpl.renameSync(tmp, target);
  } catch (err) {
    try { fsImpl.unlinkSync(tmp); } catch {}
    throw err;
  }
}
