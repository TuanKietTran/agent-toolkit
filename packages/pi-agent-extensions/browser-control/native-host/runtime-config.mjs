import { execFileSync } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { defaultConfigPath, resolveSocketPath } from "./ipc-path.mjs";

const allowed = new Set(["nodeExecutable", "hostScript", "socketPath", "pipeName", "extensionOrigin"]);
function verifyWindowsAcl(path) {
  const powershell = join(process.env.SystemRoot || process.env.WINDIR || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const script = [
    "$ErrorActionPreference='Stop'",
    "$paths=@($env:PI_BRIDGE_ACL_TARGET,(Split-Path -Parent $env:PI_BRIDGE_ACL_TARGET))",
    "$me=[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value",
    "foreach($p in $paths){$a=Get-Acl -LiteralPath $p;$owner=$a.GetOwner([System.Security.Principal.SecurityIdentifier]).Value;if($owner -ne $me){throw 'owner mismatch'};$rules=$a.GetAccessRules($true,$true,[System.Security.Principal.SecurityIdentifier]);foreach($r in $rules){$sid=$r.IdentityReference.Value;if($sid -ne $me -and $sid -ne 'S-1-5-18' -and $sid -ne 'S-1-5-32-544'){throw 'untrusted ACL principal'}}}",
    "[Console]::Write('OK')",
  ].join(";");
  try {
    const output = execFileSync(powershell, ["-NoProfile", "-NonInteractive", "-Command", script], {
      encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "ignore"],
      env: { ...process.env, PI_BRIDGE_ACL_TARGET: path },
    });
    if (output !== "OK") throw new Error("Windows ACL verification did not complete");
  } catch { throw new Error("Runtime config and parent directory must have current-user-only ACL (SYSTEM/Administrators may retain access)"); }
}

export async function verifyConfigProtection(path) {
  const file = await stat(path), parent = await stat(dirname(path));
  if (process.platform === "win32") { verifyWindowsAcl(path); return; }
  if (file.uid !== process.getuid() || (file.mode & 0o077) !== 0 || parent.uid !== process.getuid() || (parent.mode & 0o022) !== 0) {
    throw new Error("Runtime config must be current-user owned, mode 0600, in a non-group/world-writable directory");
  }
}

export async function loadRuntimeConfig(path, { required = false } = {}) {
  if (!path) path = defaultConfigPath();
  let info;
  try { info = await stat(path); }
  catch (error) {
    if (!required && error.code === "ENOENT") return { socketPath: resolveSocketPath() };
    throw error;
  }
  await verifyConfigProtection(path);
  const text = await readFile(path, "utf8");
  if (Buffer.byteLength(text, "utf8") > 16 * 1024) throw new Error("Runtime config exceeds 16 KiB");
  let config;
  try { config = JSON.parse(text); } catch { throw new Error("Runtime config is malformed JSON"); }
  if (!config || typeof config !== "object" || Array.isArray(config) || Object.keys(config).some((key) => !allowed.has(key))) throw new Error("Runtime config contains unknown fields");
  if (config.socketPath !== undefined && (typeof config.socketPath !== "string" || !config.socketPath)) throw new Error("Runtime config socketPath must be a non-empty string");
  if (config.pipeName !== undefined && (typeof config.pipeName !== "string" || !config.pipeName)) throw new Error("Runtime config pipeName must be a non-empty string");
  if (process.platform === "win32" && !config.pipeName) throw new Error("Windows host config must provide the ACL-secured pipeName");
  const endpoint = resolveSocketPath(config.pipeName || config.socketPath);
  const local = process.platform === "win32" ? endpoint.startsWith("\\\\.\\pipe\\") : endpoint.startsWith("/");
  if (!local) throw new Error("Runtime config may only specify local IPC endpoints");
  return { ...config, socketPath: endpoint, pipeName: config.pipeName || undefined, configPath: path };
}
