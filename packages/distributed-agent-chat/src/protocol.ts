// A target identifies a configured network worker, not a model or a particular harness.
export type Agent = string;
// Only modes with implemented adapters are claimable; adding an agent ID does not imply a new runtime.
export const modes = ['pi', 'claude', 'codex', 'opencode', 'mock'] as const;
export type Mode = typeof modes[number];
export const validMode = (s: unknown): s is Mode => typeof s === 'string' && modes.includes(s as typeof modes[number]);
export type Status = 'queued' | 'running' | 'done' | 'error' | 'cancelled';
export interface Run {
  id: string; agent: Agent; prompt: string; text: string; status: Status;
  mode: string; error: string; session_id: string; worker_id: string;
  lease: number; seq: number; created: number;
}
export interface Task extends Run { resume: boolean; provider_session_id?: string }
export interface Usage { input?: number; output?: number; cached?: number; cost?: number }
export type Activity = { type: 'tool'; name: string; status: 'started' | 'completed' | 'error' } |
  { type: 'usage'; usage: Usage };
export type Update = { kind: 'delta'; text: string } | { kind: 'session'; providerSessionId?: string } |
  { kind: 'activity'; activity: Activity } | { kind: 'done' } | { kind: 'error'; error: string };
export interface RoomEvent { cursor: number; run_id: string; kind: string; data: string }
export const active = (status: string) => status === 'queued' || status === 'running';
export const validId = (s: unknown): s is string => typeof s === 'string' && /^[a-zA-Z0-9_-]{1,64}$/.test(s);
export const validSessionId = (s: unknown): s is string => typeof s === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(s);
