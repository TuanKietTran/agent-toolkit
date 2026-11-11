export interface AxValue { value?: unknown }
export interface AxProperty { name: string; value?: AxValue }
export interface AxNodeLike { nodeId?: string; parentId?: string; childIds?: string[]; backendDOMNodeId?: number; ignored?: boolean; role?: AxValue; name?: AxValue; value?: AxValue; properties?: AxProperty[] }
export interface RefEntry { ref: string; backendNodeId: number; role: string; name: string }

export const INTERACTIVE_ROLES = new Set(["button", "link", "textbox", "searchbox", "combobox", "listbox", "option", "checkbox", "radio", "tab", "menuitem", "menuitemcheckbox", "menuitemradio", "switch", "slider", "spinbutton", "treeitem", "tablist"]);
export function isInteractiveRole(role: string): boolean { return INTERACTIVE_ROLES.has(role.toLowerCase()); }
function prop(node: AxNodeLike, name: string): unknown { return node.properties?.find((p) => p.name === name)?.value?.value; }
export function isInteractive(node: AxNodeLike): boolean { const role = String(node.role?.value ?? ""); if (isInteractiveRole(role)) return true; if (role.toLowerCase() === "generic" && prop(node, "focusable") === true) return true; return false; }
function clean(s: unknown): string { return String(s ?? "").replace(/[\r\n]+/g, " ").replace(/"/g, "'").trim(); }

export class SnapshotStore {
  private counter = 0;
  private byBackend = new Map<number, string>();
  private byRef = new Map<string, RefEntry>();
  refFor(backendNodeId: number, role: string, name: string): string { const ex = this.byBackend.get(backendNodeId); if (ex) { this.byRef.set(ex, { ref: ex, backendNodeId, role, name }); return ex; } const ref = "e" + ++this.counter; this.byBackend.set(backendNodeId, ref); this.byRef.set(ref, { ref, backendNodeId, role, name }); return ref; }
  resolve(ref: string): RefEntry | undefined { return this.byRef.get(ref); }
  has(ref: string): boolean { return this.byRef.has(ref); }
  issued(ref: string): boolean { const m = /^e(\d+)$/.exec(ref); return !!m && Number(m[1]) <= this.counter && Number(m[1]) >= 1; }
  entries(): RefEntry[] { return [...this.byRef.values()]; }
}
export { SnapshotStore as RefStore };
export function createSnapshotStore(): SnapshotStore { return new SnapshotStore(); }

export function buildSnapshot(nodes: AxNodeLike[], url: string, title: string, store: SnapshotStore): { text: string; entries: RefEntry[] } {
  const byId = new Map<string, AxNodeLike>();
  for (const n of nodes) if (n.nodeId) byId.set(n.nodeId, n);
  const lines: string[] = [("# " + url + " " + (title ?? "")).trim()];
  const seen = new Set<string>();
  const walk = (node: AxNodeLike, depth: number): void => {
    if (node.nodeId) { if (seen.has(node.nodeId)) return; seen.add(node.nodeId); }
    if (!node.ignored) {
      const role = clean(node.role?.value ?? "");
      const name = clean(node.name?.value ?? "");
      const rawVal = node.value?.value ?? prop(node, "value");
      const val = typeof rawVal === "string" || typeof rawVal === "number" ? clean(rawVal) : "";
      if (role || name) {
        let line = "  ".repeat(depth);
        if (node.backendDOMNodeId != null && isInteractive(node)) line += "[" + store.refFor(node.backendDOMNodeId, role, name) + "] ";
        line += role || "generic";
        if (name) line += " \"" + name + "\"";
        if (val && val !== name) line += " value=\"" + val + "\"";
        lines.push(line);
      }
    }
    for (const cid of node.childIds ?? []) { const c = byId.get(cid); if (c) walk(c, depth + (node.ignored ? 0 : 1)); }
  };
  for (const n of nodes) if (!n.parentId || !byId.has(n.parentId)) walk(n, 0);
  for (const n of nodes) if (n.nodeId && !seen.has(n.nodeId)) walk(n, 0);
  return { text: lines.join("\n"), entries: store.entries() };
}
export function formatSnapshot(nodes: AxNodeLike[], url: string, title: string, store: SnapshotStore): string { return buildSnapshot(nodes, url, title, store).text; }
export { buildSnapshot as buildSnapshotText };
