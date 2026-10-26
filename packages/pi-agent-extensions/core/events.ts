// Pi host constants shared by every extension. Names are pi's own; do not reword them.

/** Event names accepted by `pi.on(...)`, grouped by lifecycle. */
export const PI_EVENT = {
	// Session
	SESSION_START: "session_start",
	SESSION_TREE: "session_tree",
	SESSION_SHUTDOWN: "session_shutdown",
	SESSION_COMPACT: "session_compact",
	SESSION_BEFORE_COMPACT: "session_before_compact",
	// Agent
	BEFORE_AGENT_START: "before_agent_start",
	AGENT_START: "agent_start",
	AGENT_BEFORE_SETTLE: "agent_before_settle",
	AGENT_SETTLED: "agent_settled",
	// Turn and message
	TURN_END: "turn_end",
	MESSAGE_UPDATE: "message_update",
	MESSAGE_END: "message_end",
	MODEL_SELECT: "model_select",
	BEFORE_PROVIDER_REQUEST: "before_provider_request",
	AFTER_PROVIDER_RESPONSE: "after_provider_response",
	// Tools
	TOOL_CALL: "tool_call",
	TOOL_RESULT: "tool_result",
	TOOL_EXECUTION_START: "tool_execution_start",
	TOOL_EXECUTION_END: "tool_execution_end",
} as const;
