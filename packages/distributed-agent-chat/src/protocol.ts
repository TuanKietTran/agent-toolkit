export type Agent = 'pi' | 'claude';
export type Mode = Agent | 'mock';
export type Status = 'queued' | 'running' | 'done' | 'error' | 'cancelled';
export interface Run {
  id: string; agent: Agent; prompt: string; text: string; status: Status;
  mode: string; error: string; session_id: string; worker_id: string;
  lease: number; seq: number; created: number;
}
export interface Task extends Run { resume: boolean }
export type Update = { kind: 'delta'; text: string } | { kind: 'session' } |
  { kind: 'done' } | { kind: 'error'; error: string };
export interface RoomEvent { cursor: number; run_id: string; kind: string; data: string }
export const active = (status: string) => status === 'queued' || status === 'running';
export const validId = (s: unknown): s is string => typeof s === 'string' && /^[a-zA-Z0-9_-]{1,64}$/.test(s);
