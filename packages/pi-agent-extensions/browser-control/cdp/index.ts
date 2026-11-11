// CDP browser-control extension entry (bc_tools). Default export per cdp/contract.ts.
// The controller is created lazily on first use: no browser connection at load time.
// bc_cdp's controller.ts currently exports ControllerImpl; createController is also
// accepted so either shape works after the branches merge.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { Controller } from "./contract.ts";
import { registerCdpTools, resolveAgent } from "./tools.ts";

const NOTE_INFO = "info";
const NOTE_WARNING = "warning";
const USAGE = "Usage: /bc status | launch | assign <tabId> [agent] | resume";

export default function browserControlCdp(pi: ExtensionAPI, deps?: { controller?: Controller; agent?: () => string }): void {
  let controller: Controller | undefined = deps?.controller;
  let creating: Promise<Controller> | undefined;

  async function getController(): Promise<Controller> {
    if (controller) return controller;
    creating ??= (async () => {
      const mod = (await import("./controller.ts")) as { createController?: () => Controller; ControllerImpl?: new () => Controller };
      const created = typeof mod.createController === "function" ? mod.createController() : mod.ControllerImpl ? new mod.ControllerImpl() : undefined;
      if (!created) throw new Error("cdp/controller.ts exports neither createController nor ControllerImpl");
      controller = created;
      return created;
    })();
    return creating;
  }

  registerCdpTools(pi, getController, deps?.agent);

  pi.registerCommand("bc", {
    description: "CDP browser control: status | launch | assign <tabId> [agent] | resume",
    handler: async (args: string, ctx: { ui: { notify: (text: string, level?: "info" | "warning" | "error") => void } }) => {
      const notify = (text: string, level: "info" | "warning" | "error" = NOTE_INFO) => ctx.ui.notify(text, level);
      const [sub = "status", ...rest] = (args ?? "").trim().split(/\s+/).filter(Boolean);
      try {
        if (sub === "resume") {
          (await getController()).resume();
          notify("bc: halt cleared; actions resumed");
          return;
        }
        if (sub === "assign") {
          const [tabId, targetAgent] = rest;
          if (!tabId) { notify(USAGE, NOTE_WARNING); return; }
          const ctrl = await getController();
          if (!ctrl.ownership) { notify("bc: controller has no ownership registry", NOTE_WARNING); return; }
          ctrl.ownership.assign(targetAgent ?? resolveAgent(deps?.agent), tabId);
          notify(`bc: tab ${tabId} assigned to ${targetAgent ?? resolveAgent(deps?.agent)}`);
          return;
        }
        if (sub === "launch") {
          const launch = (await import("./launch.ts")) as { launchBrave: () => Promise<{ pid: number; port: number; profileDir: string }> };
          const started = await launch.launchBrave();
          const conn = await (await getController()).connect();
          notify(conn.ok ? `bc: Brave launched pid=${started.pid} port=${started.port} profile=${started.profileDir}; connected to ${conn.browser}` : `bc: Brave launched pid=${started.pid} port=${started.port}, but connect failed: ${conn.message}`, conn.ok ? NOTE_INFO : NOTE_WARNING);
          return;
        }
        if (sub === "status") {
          const ctrl = await getController();
          const conn = await ctrl.connect();
          const halt = ctrl.halted();
          const owned = ctrl.ownership ? ctrl.ownership.list(resolveAgent(deps?.agent)) : [];
          notify(`bc: ${conn.ok ? `connected to ${conn.browser}` : conn.message}; agent=${resolveAgent(deps?.agent)}; owned tabs=${owned.length ? owned.join(",") : "none"}${halt ? `; HALTED ${halt.reason} on ${halt.tab} (${halt.url}) - /bc resume to continue` : ""}`, conn.ok ? NOTE_INFO : NOTE_WARNING);
          return;
        }
        notify(USAGE, NOTE_WARNING);
      } catch (error) {
        notify(`bc: ${error instanceof Error ? error.message : String(error)}`, NOTE_WARNING);
      }
    },
  });

  pi.on("session_shutdown", async () => {
    await controller?.close().catch(() => undefined);
  });
}
