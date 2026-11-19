// Live end-to-end run with a REAL model: the same scenarios as tests/agent-e2e.test.ts, but the model
// decides every step. Uses your pi credentials; costs tokens. Not part of `npm test`.
//
//   node scripts/live-agent-e2e.ts [--model provider/id] [--root <package dir under test>] [--only 1,2]
//
// --root lets the same scenarios run against another checkout of this package (for before/after
// comparisons); fixtures and the headless browser always come from this checkout.
import { existsSync, mkdtempSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager, createAgentSession } from "@earendil-works/pi-coding-agent";
import { startFixtureServer } from "../browser-control/cdp/fixture/server.ts";
import { startTestBrowser } from "../browser-control/cdp/tests/browser-harness.ts";

const arg = (name: string, fallback?: string) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : fallback; };
const [provider, modelId] = (arg("--model", process.env.PI_LIVE_MODEL ?? "groq/llama-3.3-70b-versatile")!).split(/\/(.*)/s);
const root = resolve(arg("--root", resolve(import.meta.dirname, ".."))!);
const only = arg("--only")?.split(",");
/** Optional tokens-per-minute budget for rate-limited providers (estimated from the request size). */
const tpm = Number(arg("--tpm", process.env.PI_LIVE_TPM ?? "0")) || 0;
const sent: { t: number; tokens: number }[] = [];
const throttle = (pi: any) => pi.on("before_provider_request", async (event: { payload: unknown }) => {
  if (!tpm) return undefined;
  const tokens = Math.ceil(JSON.stringify(event.payload).length / 4) + 800;
  for (;;) {
    while (sent.length && Date.now() - sent[0].t > 61_000) sent.shift();
    // A request bigger than the whole budget still goes out once the window is empty.
    if (!sent.length || sent.reduce((a, b) => a + b.tokens, 0) + tokens <= tpm) break;
    await new Promise((r) => setTimeout(r, 1000));
  }
  sent.push({ t: Date.now(), tokens });
  return undefined;
});
const agentDir = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");

const { default: browserControlCdp } = await import(pathToFileURL(join(root, "browser-control/cdp/index.ts")).href);
const { createController } = await import(pathToFileURL(join(root, "browser-control/cdp/controller.ts")).href);

interface Scenario { id: string; prompt: string; check: (s: { url: string; finalText: string; page: string }) => boolean }
const scenarios = (origin: string): Scenario[] => [
  { id: "1", prompt: `Open the test website at ${origin}/site.html and navigate to its documentation page. Tell me when you are there.`, check: (s) => /\/docs\.html$/.test(s.url) },
  { id: "2", prompt: `Go to ${origin}/search.html, find the search field, search for "rocket", and open the first result. Tell me which item page you opened.`, check: (s) => /item\.html\?id=r7$/.test(s.url) },
  { id: "3", prompt: `Open ${origin}/contact.html and complete the form: full name "Ada Lovelace", email "ada@example.com", topic Billing, message "Invoice question". Then submit it - I confirm the submission. Tell me what the confirmation page says.`, check: (s) => /Name: Ada Lovelace \| Email: ada@example\.com \| Topic: billing \| Message: Invoice question/.test(s.page) },
  { id: "4", prompt: `Open ${origin}/dynamic.html, press the "Refresh status" button, wait for the status to finish loading, and report the exact status text.`, check: (s) => /All systems operational \(check #1, 3 services healthy\)/.test(s.finalText) },
  { id: "10", prompt: `In the shop at ${origin}/shop.html, add the Rocket Skates to the cart. Confirm what the cart shows.`, check: (s) => /Cart: 1 item \(Rocket Skates\)/.test(s.page) && /rocket skates/i.test(s.finalText) },
  { id: "9", prompt: `Visit the catalog at ${origin}/catalog.html, find the Rocket Sled, open its detail page, and give me its price, SKU and stock status as a JSON object.`, check: (s) => s.finalText.includes("899.00") && s.finalText.includes("RKT-SL9") && /out of stock/i.test(s.finalText) },
];

const fx = await startFixtureServer();
const br = await startTestBrowser();
const results: Record<string, unknown>[] = [];
try {
  for (const sc of scenarios(fx.origin).filter((s) => !only || only.includes(s.id))) {
    const dir = mkdtempSync(join(tmpdir(), "pi-live-"));
    const controller = createController({ port: br.port });
    const settingsManager = SettingsManager.inMemory({ retry: { enabled: true, maxRetries: 4 } } as never);
    const loader = new DefaultResourceLoader({ cwd: dir, agentDir: dir, settingsManager, noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true, extensionFactories: [(pi: any) => browserControlCdp(pi, { controller, agent: () => "live" }), throttle] } as never);
    await loader.reload();
    const modelRuntime = await ModelRuntime.create({ authPath: join(agentDir, "auth.json"), modelsPath: existsSync(join(agentDir, "models.json")) ? join(agentDir, "models.json") : null, allowModelNetwork: false });
    const model = modelRuntime.getModel(provider, modelId);
    if (!model) throw new Error(`model ${provider}/${modelId} is not available`);
    const { session } = await createAgentSession({ cwd: dir, agentDir: dir, modelRuntime, model, resourceLoader: loader, sessionManager: SessionManager.inMemory(dir), settingsManager, noTools: "builtin" });
    await session.bindExtensions({});
    const t0 = Date.now();
    let firstToken: number | undefined;
    const tools: { name: string; error: boolean; verified?: boolean; ms: number }[] = [];
    const starts = new Map<string, number>();
    session.subscribe((e: any) => {
      if (e.type === "message_update" && e.assistantMessageEvent?.type === "text_delta") firstToken ??= Date.now() - t0;
      if (e.type === "tool_execution_start") starts.set(e.toolCallId, Date.now());
      if (e.type === "tool_execution_end") tools.push({ name: e.toolName, error: e.isError || e.result?.details?.ok === false, verified: e.result?.details?.verification?.verified, ms: Date.now() - (starts.get(e.toolCallId) ?? Date.now()) });
    });
    let error: string | undefined;
    const timeout = setTimeout(() => void session.abort(), 600_000);
    try { await session.prompt(sc.prompt); await session.waitForIdle(); } catch (e) { error = (e as Error).message; }
    clearTimeout(timeout);
    const finalText = session.getLastAssistantText() ?? "";
    const lastAssistant = [...session.messages].reverse().find((m: any) => m.role === "assistant") as any;
    if (!error && lastAssistant?.stopReason === "error") error = String(lastAssistant.errorMessage ?? "model error");
    const tabs: any = await controller.call("live", "tabs_list", {});
    const tab = tabs.data?.tabs?.at(-1);
    const url = tab ? String((tabs.text as string).split("\n").find((l: string) => l.startsWith(tab))?.split(" ")[1] ?? "") : "";
    const page = tab ? String(((await controller.call("live", "snapshot", { tab })) as any).text ?? "") : "";
    const success = !error && sc.check({ url, finalText, page });
    const claimsSuccess = !!finalText && !/(could not|couldn't|unable|failed|not able|error|did not|didn't)/i.test(finalText);
    results.push({ scenario: sc.id, success, incorrectSuccessClaim: !success && claimsSuccess, ms: Date.now() - t0, timeToFirstTokenMs: firstToken, toolCalls: tools.length, toolErrors: tools.filter((t) => t.error).length, verified: tools.filter((t) => t.verified === true).length, notVerified: tools.filter((t) => t.verified === false).length, tools: tools.map((t) => t.name + (t.error ? "!" : t.verified === false ? "?" : "")).join(" "), url, finalText: finalText.slice(0, 300), ...(error ? { error } : {}) });
    console.log(JSON.stringify(results.at(-1)));
    session.dispose();
    await controller.close();
  }
} finally {
  await br.close();
  await fx.close();
}
const done = results.filter((r) => r.success).length;
console.log(`# live summary model=${provider}/${modelId} root=${root === resolve(import.meta.dirname, "..") ? "this checkout" : root} completed=${done}/${results.length} incorrect_success_claims=${results.filter((r) => r.incorrectSuccessClaim).length}`);
