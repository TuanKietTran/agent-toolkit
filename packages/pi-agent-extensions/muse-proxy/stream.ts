/**
 * SSE handling for muse-proxy and detection of Muse's canned refusal.
 *
 * With `stream: true` the proxy tags every chunk with `muse_proxy.kind`:
 * `progress` (status text), `reply` (one completed Muse message) or `cancel`.
 * Reading replies separately keeps a canned refusal from hiding a real reply.
 */

export interface MuseChunk {
  kind: "progress" | "reply" | "cancel" | "other";
  text: string;
  error?: string;
}

/** Incremental `data:` line parser that tolerates chunk boundaries anywhere. */
export class SseParser {
  private buffer = "";

  push(text: string): MuseChunk[] {
    this.buffer += text;
    const out: MuseChunk[] = [];
    let index: number;
    while ((index = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, index).replace(/\r$/, "");
      this.buffer = this.buffer.slice(index + 1);
      if (!line.startsWith("data:")) continue;
      const data = line.slice(5).trim();
      if (!data || data === "[DONE]") continue;
      let json: any;
      try { json = JSON.parse(data); } catch { continue; }
      if (json?.error) {
        out.push({ kind: "other", text: "", error: String(json.error.message ?? json.error) });
        continue;
      }
      const kind = json?.muse_proxy?.kind;
      const text: string = json?.choices?.[0]?.delta?.content ?? "";
      if (kind === "progress" || kind === "reply" || kind === "cancel") out.push({ kind, text });
      else if (text) out.push({ kind: "other", text });
    }
    return out;
  }
}

const APOLOGY = /(sorry|lo siento|désolé|desole|entschuldig|scusa|xin lỗi|申し訳|ごめん|抱歉|对不起|죄송)/i;
const CANNOT = /(can['’]?t|cannot|unable|no puedo|impossible|ne peux|kann nicht|non posso|không thể|できません|无法|할 수 없)/i;

/** Muse's canned "Sorry, I can't help you with this request at the moment." in any language. */
export function isRefusal(text: string): boolean {
  const flat = text.trim();
  return flat.length > 0 && flat.length <= 250 && APOLOGY.test(flat) && CANNOT.test(flat);
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error("aborted"));
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => { clearTimeout(timer); reject(new Error("aborted")); }, { once: true });
  });
}

/** Connection-level failures worth retrying (the proxy reports 502 when Muse's socket drops). */
export function isTransient(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /disconnected|connection|muse_connection|fetch failed|ECONNRESET|socket|\b50[234]\b|timed? ?out|temporar/i.test(message)
    && !/aborted/i.test(message);
}
