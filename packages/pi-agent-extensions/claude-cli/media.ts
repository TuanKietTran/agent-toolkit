import type { Message } from "@earendil-works/pi-ai";

type ClaudeInputBlock =
  | { type: "text"; text: string }
  | {
      type: "image";
      source: { type: "base64"; media_type: string; data: string };
    };

/** Build one Claude Code stream-json user event: one text block per transcript entry, plus the images of the newest message or tool-result batch. */
export function createClaudeStreamInput(newest: Message[], textBlocks: string[]): string {
  const content: ClaudeInputBlock[] = textBlocks.map((text) => ({ type: "text", text }));

  for (const message of newest) {
    if (!Array.isArray(message.content)) continue;
    for (const block of message.content) {
      if (block.type !== "image") continue;
      content.push({
        type: "image",
        source: {
          type: "base64",
          media_type: block.mimeType,
          data: block.data,
        },
      });
    }
  }

  return `${JSON.stringify({
    type: "user",
    message: { role: "user", content },
  })}\n`;
}
