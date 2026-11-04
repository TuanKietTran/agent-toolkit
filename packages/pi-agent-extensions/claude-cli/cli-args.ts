/** Optional Claude CLI flags driven by the environment. */

/**
 * `claude --advisor <model>` (present in Claude Code but not listed in `--help`) lets the
 * main model consult a stronger one server-side. Measured cost: about 1.6k extra input
 * tokens on every request for the advisor tool definition, so it is opt-in:
 * PI_CLAUDE_CLI_ADVISOR=opus.
 */
export function advisorArgs(env: Record<string, string | undefined> = process.env): string[] {
  const model = env.PI_CLAUDE_CLI_ADVISOR?.trim();
  return model && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(model) ? ["--advisor", model] : [];
}
