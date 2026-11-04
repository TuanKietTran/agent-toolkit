# muse-proxy provider for pi

Registers the `muse` provider, which lets pi use Muse (tools included) through a
[muse-proxy](https://github.com/uezo/muse-proxy) over its OpenAI-compatible
`/v1/chat/completions` API.

```sh
pi --provider muse --model muse
```

## Configuration

First match wins:

1. `PI_MUSE_PROXY_URL` (default `http://pi4:8766/v1`) and `PI_MUSE_PROXY_KEY`
2. `~/.pi/agent/muse-proxy.json`, mode `0600`:
   ```json
   { "baseUrl": "http://pi4:8766/v1", "apiKey": "<proxy api_key>" }
   ```

`PI_MUSE_PROXY_MAX_CHARS` (default 15000) caps one request; keep it at or below
the proxy's `max_message_chars` (16000 by default).

The key is the proxy's own `api_key` from `proxy.toml`, not a Muse credential.

## Behaviour and limits

- **Tools through plain conversation.** The proxy rejects client-supplied tool
  definitions, and Muse refuses a "harness" framing and does not run pi's
  tools. So the first message says "I'm working on my laptop and you are the
  brain while I act as your hands", lists pi's active tools as signatures, and
  asks for one line per action:
  `@@RUN {"name":"read","arguments":{"path":"/etc/hosts"}}`. The provider
  validates the name and required arguments, emits a real pi ToolCall, and pi
  runs it. The result goes back as `OUTPUT (read, ok): ...`. Text Muse writes
  before a request is shown as thinking. A malformed request is sent back to
  Muse for correction (up to two retries) before it is treated as an answer.
  A `<run>{...}</run>` block is accepted too.
- **Muse still has its own sandbox.** It follows the protocol when asked to be
  the brain for your laptop, but nothing enforces it: a question that needs no
  tool is simply answered. Without active tools the provider falls back to
  plain chat.
- **Server-side history.** Muse keeps the conversation per `session_id` and the
  proxy forwards only the last user message. The provider keeps one Muse session
  per pi conversation and sends only the messages Muse has not seen. The first
  turn (and any turn after a rewind or pi restart) sends the tool list, pi's
  system prompt (clipped) and the history, newest messages first when it must
  be cut. Parallel tool results share the request budget evenly.
- **Latency.** Requests are non-streaming; expect roughly 6 to 20 seconds per
  turn, so tool loops are slow.
- Each pi conversation creates a Muse side chat; use the proxy only for this.
- **Side-chat lifecycle.** The provider tracks every side chat it starts.
  - *Quit, reload, `/new`, resume, fork:* all of them are retired, so a new
    conversation never resumes an old chat. Chats dropped mid-session (rewind,
    rotation after a refusal) are retired too.
  - *`/compact` (also automatic compaction):* the summary is requested as plain
    text with no tool protocol. When it succeeds, every related chat is retired
    and the next turn opens one new chat that starts from the summary. If
    compaction fails or is cancelled, the conversation's own chats stay and
    only the chat opened for the summary is retired.
  - *Limit:* neither muse-proxy nor the Muse Gadget SDK has a call that deletes
    a side chat, so "retired" means the extension forgets and never reuses it.
    Remove the leftovers in the Muse app. `reap()` in `index.ts` is the single
    place to add real deletion if the proxy gains it. `PI_MUSE_PROXY_DEBUG=<file>`
    logs each retirement.

## Setting up the proxy

See the muse-proxy README. Pairing uses the Muse Gadget SDK on a Linux machine
with Bluetooth LE, then the three credential files are copied into the proxy's
`state_dir`. Bind the proxy to a private interface (for example the Tailscale
address) and keep its `api_key` secret.

## Tests

```sh
node --test muse-proxy/*.test.ts
```

## Debugging

`PI_MUSE_PROXY_DEBUG=/path/to/file.jsonl` appends every request and reply
(session id, text sent, replies received) so a failing conversation can be
replayed. The file contains your prompts and tool output; delete it afterwards.
