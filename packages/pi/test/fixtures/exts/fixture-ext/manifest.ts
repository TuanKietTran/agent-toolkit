import type { ExtManifest } from "../../../../src/core/types.js";

/** A tiny extension used by the tests: it writes one file and checks for it. */
export const manifest: ExtManifest = {
  name: "fixture-ext",
  version: "9.9.9",
  description: "test fixture: writes a marker file",
  targets: ["host"],
  config: [{ key: "marker", description: "path of the marker file", required: true }],
};

export default manifest;
