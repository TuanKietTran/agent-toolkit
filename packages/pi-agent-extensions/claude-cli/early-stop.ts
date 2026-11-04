/**
 * Decides when the `claude` subprocess has said everything Pi needs, and reads the
 * requested host calls straight from its stream.
 *
 * Pi only needs Claude's first assistant message when that message requests host
 * tools: Pi runs them and starts a new turn with the results. Left alone, Claude
 * Code would feed the capture acknowledgement back to the model and make two more
 * API round trips (an acknowledgement turn and a structured-output turn) whose
 * output Pi throws away.
 *
 * The calls are taken from the streamed `tool_use` blocks (name plus the
 * concatenated `input_json_delta` parts) once the message is complete, not from the
 * MCP capture handlers: whether and when Claude Code invokes those (in parallel,
 * one after another, or not at all for a rejected call) is its business, and
 * waiting for them could stall a turn.
 */
export const HOST_TOOL_PREFIX = "mcp__pi-host__";

export interface HostCall {
  name: string;
  arguments: Record<string, unknown>;
}

export type StopDecision =
  /** Stop the process now and use these calls. */
  | { stop: true; calls: HostCall[] }
  /** Let Claude Code carry on with its normal flow. */
  | { stop: false };

interface ToolBlock {
  name: string;
  json: string;
}

export class EarlyStop {
  private blocks = new Map<number, ToolBlock>();
  private disabled = false;
  private done = false;

  private readonly activeTools: ReadonlySet<string>;

  constructor(activeTools: ReadonlySet<string>) {
    this.activeTools = activeTools;
  }

  /** Feed every `stream_event` payload. Returns a decision at the end of a message that needs one. */
  observe(event: any): StopDecision | undefined {
    if (!event || this.done || this.disabled) return undefined;
    switch (event.type) {
      case "message_start":
        this.blocks.clear();
        return undefined;
      case "content_block_start":
        if (event.content_block?.type === "tool_use") {
          this.blocks.set(event.index, { name: String(event.content_block.name ?? ""), json: "" });
        }
        return undefined;
      case "content_block_delta": {
        const block = this.blocks.get(event.index);
        if (block && event.delta?.type === "input_json_delta") block.json += String(event.delta.partial_json ?? "");
        return undefined;
      }
      case "message_stop":
        return this.decide();
      default:
        return undefined;
    }
  }

  private decide(): StopDecision | undefined {
    const blocks = [...this.blocks.values()];
    if (blocks.length === 0) return undefined; // plain text or thinking only: nothing to decide yet
    const calls: HostCall[] = [];
    for (const block of blocks) {
      const tool = block.name.startsWith(HOST_TOOL_PREFIX) ? block.name.slice(HOST_TOOL_PREFIX.length) : undefined;
      let args: unknown;
      try {
        args = block.json.trim() ? JSON.parse(block.json) : {};
      } catch {
        args = undefined;
      }
      if (!tool || !this.activeTools.has(tool) || !args || typeof args !== "object" || Array.isArray(args)) {
        // Mixed with structured output, an unknown tool or unreadable arguments: use the normal flow.
        this.disabled = true;
        return { stop: false };
      }
      calls.push({ name: tool, arguments: args as Record<string, unknown> });
    }
    this.done = true;
    return { stop: true, calls };
  }
}
