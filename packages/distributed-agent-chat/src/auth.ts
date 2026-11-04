import { validId } from './protocol';

export interface TokenEnv { CHAT_TOKEN?: string; PI_TOKEN?: string; CLAUDE_TOKEN?: string; AGENT_TOKENS?: string }
type TokenSource = TokenEnv | Record<string, string | undefined>;
export function agentTokens(env: TokenSource): Record<string, string> {
  if (env.AGENT_TOKENS !== undefined) {
    const entries: unknown = JSON.parse(env.AGENT_TOKENS);
    if (!entries || typeof entries !== 'object' || Array.isArray(entries)) throw Error('Invalid AGENT_TOKENS');
    const pairs = Object.entries(entries);
    if (!pairs.length || pairs.length > 64 || pairs.some(([id, token]) => !validId(id) || typeof token !== 'string' || !token)) throw Error('Invalid AGENT_TOKENS');
    return Object.fromEntries(pairs);
  }
  return Object.fromEntries([['pi', env.PI_TOKEN], ['claude', env.CLAUDE_TOKEN]].filter((pair): pair is [string, string] => !!pair[1]));
}
export function validateSecrets(env: TokenSource) {
  const tokens = [env.CHAT_TOKEN, ...Object.values(agentTokens(env))].filter((token): token is string => typeof token === 'string');
  if (!env.CHAT_TOKEN || tokens.length < 2 || tokens.some(token => token.length < 24) || new Set(tokens).size !== tokens.length) throw Error('Use distinct random chat and worker tokens of at least 24 characters');
}
