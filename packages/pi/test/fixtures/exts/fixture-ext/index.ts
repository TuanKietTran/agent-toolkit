import { succeeds } from "../../../../src/core/exec.js";
import type { InstallerPlugin } from "../../../../src/core/types.js";

const exists = (path: string) =>
  `process.exit(require("fs").existsSync(${JSON.stringify(path)}) ? 0 : 1)`;
const write = (path: string) => `require("fs").writeFileSync(${JSON.stringify(path)}, "ok")`;
const unlink = (path: string) => `require("fs").rmSync(${JSON.stringify(path)}, {force: true})`;

export const plugin: InstallerPlugin = {
  name: "fixture-ext",

  async check(target, ctx) {
    const marker = ctx.config.require("marker");
    return succeeds(ctx.run, target, [process.execPath, "-e", exists(marker)]);
  },

  async install(target, ctx) {
    const marker = ctx.config.require("marker");
    ctx.log.step(`writing ${marker}`);
    await ctx.run(target, [process.execPath, "-e", write(marker)]);
  },

  async remove(target, ctx) {
    const marker = ctx.config.require("marker");
    await ctx.run(target, [process.execPath, "-e", unlink(marker)]);
  },
};

export default plugin;
