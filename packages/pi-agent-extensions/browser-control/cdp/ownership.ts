import type { Ownership } from "./contract.ts";

export function createOwnership(): Ownership {
  const map = new Map<string, string>();
  return {
    register(agent: string, tabId: string): void { map.set(tabId, agent); },
    assign(agent: string, tabId: string): void { map.set(tabId, agent); },
    release(tabId: string): void { map.delete(tabId); },
    owner(tabId: string): string | undefined { return map.get(tabId); },
    owns(agent: string, tabId: string): boolean { return map.get(tabId) === agent; },
    list(agent: string): string[] { return [...map.entries()].filter(([, a]) => a === agent).map(([t]) => t); },
  };
}
