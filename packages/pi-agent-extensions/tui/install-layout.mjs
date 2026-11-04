#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const PACKAGE_NAME = "@earendil-works/pi-coding-agent";

function commandPath(command) {
  try {
    return execFileSync("which", [command], { encoding: "utf8" }).trim();
  } catch {
    return undefined;
  }
}

function packageRootCandidates() {
  const candidates = [];
  if (process.env.PI_PACKAGE_DIR) candidates.push(resolve(process.env.PI_PACKAGE_DIR));
  const piCommand = commandPath("pi");
  if (piCommand) {
    const piBin = realpathSync(piCommand);
    candidates.push(resolve(dirname(piBin), "../libexec/lib/node_modules", PACKAGE_NAME));
    if (piBin.endsWith("/dist/bundle/cli.js")) candidates.push(resolve(dirname(piBin), "../.."));
  }
  try {
    const npmRoot = execFileSync("npm", ["root", "-g"], { encoding: "utf8" }).trim();
    candidates.push(join(npmRoot, PACKAGE_NAME));
  } catch {
    // npm is optional for Homebrew installations.
  }
  return [...new Set(candidates)];
}

function findPackageRoot() {
  for (const candidate of packageRootCandidates()) {
    if (existsSync(join(candidate, "dist", "modes", "interactive", "chat-viewport.js"))) return candidate;
  }
  throw new Error("Could not locate @earendil-works/pi-coding-agent. Set PI_PACKAGE_DIR to its package root.");
}

function replaceVariant(text, variants, desired, label) {
  if (text.includes(desired)) return { text, changed: false };
  const matches = variants.filter((variant) => text.includes(variant));
  if (matches.length !== 1) throw new Error(`Unexpected Pi ${label}; refusing an ambiguous patch`);
  return { text: text.replace(matches[0], desired), changed: true };
}

function patchFile(file, transforms) {
  let text = readFileSync(file, "utf8");
  let changed = false;
  for (const transform of transforms) {
    const result = replaceVariant(text, transform.variants, transform.desired, `${transform.label} in ${file}`);
    text = result.text;
    changed ||= result.changed;
  }
  if (changed) writeFileSync(file, text);
  return changed;
}

const root = findPackageRoot();
const viewport = join(root, "dist", "modes", "interactive", "chat-viewport.js");
const prettyChanged = patchFile(viewport, [
  {
    label: "chat column",
    variants: [
      '        { component: transcript, basis: 0, grow: 1, shrink: 1, minSize: 1 },\n        { component: options.tools, basis: "auto", shrink: 1, minSize: 0 },\n        { component: options.pendingMessages, basis: "auto", shrink: 1, minSize: 0 },\n        ...(options.widgetsAbove === undefined ? [] : [{ component: options.widgetsAbove, shrink: 1, minSize: 0 }]),\n        { component: options.editor, basis: "auto", shrink: 1, minSize: 3 },\n        ...(options.widgetsBelow === undefined ? [] : [{ component: options.widgetsBelow, shrink: 1, minSize: 0 }]),',
      '        { component: transcript, basis: 0, grow: 1, shrink: 1, minSize: 1 },\n        { component: options.pendingMessages, basis: "auto", shrink: 1, minSize: 0 },\n        ...(options.widgetsAbove === undefined ? [] : [{ component: options.widgetsAbove, shrink: 1, minSize: 0 }]),\n        { component: options.editor, basis: "auto", shrink: 1, minSize: 3 },\n        ...(options.widgetsBelow === undefined ? [] : [{ component: options.widgetsBelow, shrink: 1, minSize: 0 }]),',
      '        { component: transcript, basis: 0, grow: 1, shrink: 1, minSize: 1 },\n        { component: options.pendingMessages, basis: "auto", shrink: 1, minSize: 0 },\n        { component: options.editor, basis: "auto", shrink: 1, minSize: 3 },',
    ],
    desired: '        { component: transcript, basis: 0, grow: 1, shrink: 1, minSize: 1 },\n        { component: options.editor, basis: "auto", shrink: 1, minSize: 3 },',
  },
  {
    label: "metadata column",
    variants: [
      '        { component: options.status, basis: "auto", shrink: 1, minSize: 0 },\n        { component: options.footer, basis: "auto", shrink: 1, minSize: 0 },',
      '        { component: options.tools, basis: "auto", shrink: 1, minSize: 0 },\n        { component: options.status, basis: "auto", shrink: 1, minSize: 0 },\n        { component: options.footer, basis: "auto", shrink: 1, minSize: 0 },',
      '        { component: options.tools, basis: "auto", shrink: 1, minSize: 0 },\n        ...(options.widgetsAbove === undefined ? [] : [{ component: options.widgetsAbove, basis: "auto", shrink: 1, minSize: 0 }]),\n        { component: options.status, basis: 0, grow: 1, shrink: 1, minSize: 0 },\n        ...(options.widgetsBelow === undefined ? [] : [{ component: options.widgetsBelow, basis: "auto", shrink: 1, minSize: 0 }]),\n        { component: options.footer, basis: "auto", shrink: 1, minSize: 0 },',
      '        { component: options.tools, basis: "auto", shrink: 1, minSize: 0, visible: () => globalThis[Symbol.for("pi.tui.right-panel.v1")]?.active === "tools" },\n        ...(options.widgetsAbove === undefined ? [] : [{ component: options.widgetsAbove, basis: "auto", shrink: 1, minSize: 0 }]),\n        { component: options.status, basis: 0, grow: 1, shrink: 1, minSize: 0 },\n        ...(options.widgetsBelow === undefined ? [] : [{ component: options.widgetsBelow, basis: "auto", shrink: 1, minSize: 0 }]),\n        { component: options.pendingMessages, basis: "auto", shrink: 1, minSize: 0 },\n        { component: options.footer, basis: "auto", shrink: 1, minSize: 0 },',
      '        { component: options.tools, basis: "auto", shrink: 1, minSize: 0 },\n        ...(options.widgetsAbove === undefined ? [] : [{ component: options.widgetsAbove, basis: "auto", shrink: 1, minSize: 0 }]),\n        { component: options.status, basis: 0, grow: 1, shrink: 1, minSize: 0 },\n        ...(options.widgetsBelow === undefined ? [] : [{ component: options.widgetsBelow, basis: "auto", shrink: 1, minSize: 0 }]),\n        { component: options.pendingMessages, basis: "auto", shrink: 1, minSize: 0 },\n        { component: options.footer, basis: "auto", shrink: 1, minSize: 0 },',
    ],
    desired: '        ...(options.widgetsAbove === undefined ? [] : [{ component: options.widgetsAbove, basis: "auto", shrink: 1, minSize: 0 }]),\n        { component: options.tools, basis: "auto", shrink: 1, minSize: 0, visible: () => globalThis[Symbol.for("pi.tui.right-panel.v1")]?.active === "tools" },\n        { component: options.status, basis: 0, grow: 1, shrink: 1, minSize: 0 },\n        ...(options.widgetsBelow === undefined ? [] : [{ component: options.widgetsBelow, basis: "auto", shrink: 1, minSize: 0 }]),\n        { component: options.pendingMessages, basis: "auto", shrink: 1, minSize: 0 },\n        { component: options.footer, basis: "auto", shrink: 1, minSize: 0 },',
  },
  {
    label: "responsive right panel",
    variants: [
      '    return {\n        transcript,\n        root: new HStack([\n            { component: chat, basis: 0, grow: 1, shrink: 1, minSize: 1 },\n            { component: metadata, basis: 44, grow: 0, shrink: 1, minSize: 28 },\n        ], { gap: 1 }),\n    };',
    ],
    desired: '    const panelStateKey = Symbol.for("pi.tui.right-panel.v1");\n    const panelState = (globalThis[panelStateKey] ??= { collapsed: false });\n    const panelVisible = (minimum, maximum = Infinity) => (viewport) => !panelState.collapsed && viewport.width >= minimum && viewport.width < maximum;\n    return {\n        transcript,\n        root: new HStack([\n            { component: chat, basis: 0, grow: 1, shrink: 1, minSize: 1 },\n            { component: metadata, basis: 52, grow: 0, shrink: 0, minSize: 52, visible: panelVisible(150) },\n            { component: metadata, basis: 44, grow: 0, shrink: 0, minSize: 44, visible: panelVisible(120, 150) },\n            { component: metadata, basis: 36, grow: 0, shrink: 0, minSize: 36, visible: panelVisible(92, 120) },\n            { component: metadata, basis: 28, grow: 0, shrink: 0, minSize: 28, visible: panelVisible(72, 92) },\n        ], { gap: 1 }),\n    };',
  },
]);

const chunksDir = join(root, "dist", "bundle", "chunks");
const chunkFiles = readdirSync(chunksDir).filter((name) => name.endsWith(".js")).map((name) => join(chunksDir, name));
const bundle = chunkFiles.find((file) => readFileSync(file, "utf8").includes("component:options.pendingMessages") && readFileSync(file, "utf8").includes("metadata=new VStack"));
if (!bundle) throw new Error(`Could not locate Pi's bundled chat viewport in ${chunksDir}`);

const stockBundle = ',{component:options.tools,basis:"auto",shrink:1,minSize:0},{component:options.pendingMessages,basis:"auto",shrink:1,minSize:0},...options.widgetsAbove===void 0?[]:[{component:options.widgetsAbove,shrink:1,minSize:0}],{component:options.editor,basis:"auto",shrink:1,minSize:3},...options.widgetsBelow===void 0?[]:[{component:options.widgetsBelow,shrink:1,minSize:0}]]),metadata=new VStack([{component:options.status,basis:"auto",shrink:1,minSize:0},{component:options.footer,basis:"auto",shrink:1,minSize:0}])';
const firstPatchBundle = ',{component:options.pendingMessages,basis:"auto",shrink:1,minSize:0},...options.widgetsAbove===void 0?[]:[{component:options.widgetsAbove,shrink:1,minSize:0}],{component:options.editor,basis:"auto",shrink:1,minSize:3},...options.widgetsBelow===void 0?[]:[{component:options.widgetsBelow,shrink:1,minSize:0}]]),metadata=new VStack([{component:options.tools,basis:"auto",shrink:1,minSize:0},{component:options.status,basis:"auto",shrink:1,minSize:0},{component:options.footer,basis:"auto",shrink:1,minSize:0}])';
const previousBundle = ',{component:options.pendingMessages,basis:"auto",shrink:1,minSize:0},{component:options.editor,basis:"auto",shrink:1,minSize:3}]),metadata=new VStack([{component:options.tools,basis:"auto",shrink:1,minSize:0},...options.widgetsAbove===void 0?[]:[{component:options.widgetsAbove,basis:"auto",shrink:1,minSize:0}],{component:options.status,basis:0,grow:1,shrink:1,minSize:0},...options.widgetsBelow===void 0?[]:[{component:options.widgetsBelow,basis:"auto",shrink:1,minSize:0}],{component:options.footer,basis:"auto",shrink:1,minSize:0}])';
const currentBundle = ',{component:options.editor,basis:"auto",shrink:1,minSize:3}]),metadata=new VStack([{component:options.tools,basis:"auto",shrink:1,minSize:0,visible:panelTab("tools")},...options.widgetsAbove===void 0?[]:[{component:options.widgetsAbove,basis:"auto",shrink:1,minSize:0}],{component:options.status,basis:0,grow:1,shrink:1,minSize:0},...options.widgetsBelow===void 0?[]:[{component:options.widgetsBelow,basis:"auto",shrink:1,minSize:0}],{component:options.pendingMessages,basis:"auto",shrink:1,minSize:0},{component:options.footer,basis:"auto",shrink:1,minSize:0}])';
const inlineCurrentBundle = ',{component:options.editor,basis:"auto",shrink:1,minSize:3}]),metadata=new VStack([{component:options.tools,basis:"auto",shrink:1,minSize:0,visible:()=>globalThis[Symbol.for("pi.tui.right-panel.v1")]?.active==="tools"},...options.widgetsAbove===void 0?[]:[{component:options.widgetsAbove,basis:"auto",shrink:1,minSize:0}],{component:options.status,basis:0,grow:1,shrink:1,minSize:0},...options.widgetsBelow===void 0?[]:[{component:options.widgetsBelow,basis:"auto",shrink:1,minSize:0}],{component:options.pendingMessages,basis:"auto",shrink:1,minSize:0},{component:options.footer,basis:"auto",shrink:1,minSize:0}])';
const staticBundleRoot = 'return{transcript,root:new HStack([{component:chat,basis:0,grow:1,shrink:1,minSize:1},{component:metadata,basis:44,grow:0,shrink:1,minSize:28}],{gap:1})}';
const responsiveBundleRoot = 'let panelStateKey=Symbol.for("pi.tui.right-panel.v1"),panelState=globalThis[panelStateKey]??={collapsed:!1},panelVisible=(minimum,maximum=1/0)=>viewport=>!panelState.collapsed&&viewport.width>=minimum&&viewport.width<maximum;return{transcript,root:new HStack([{component:chat,basis:0,grow:1,shrink:1,minSize:1},{component:metadata,basis:52,grow:0,shrink:0,minSize:52,visible:panelVisible(150)},{component:metadata,basis:44,grow:0,shrink:0,minSize:44,visible:panelVisible(120,150)},{component:metadata,basis:36,grow:0,shrink:0,minSize:36,visible:panelVisible(92,120)},{component:metadata,basis:28,grow:0,shrink:0,minSize:28,visible:panelVisible(72,92)}],{gap:1})}';
const desiredBundle = ',{component:options.editor,basis:"auto",shrink:1,minSize:3}]),metadata=new VStack([...options.widgetsAbove===void 0?[]:[{component:options.widgetsAbove,basis:"auto",shrink:1,minSize:0}],{component:options.tools,basis:"auto",shrink:1,minSize:0,visible:()=>globalThis[Symbol.for("pi.tui.right-panel.v1")]?.active==="tools"},{component:options.status,basis:0,grow:1,shrink:1,minSize:0},...options.widgetsBelow===void 0?[]:[{component:options.widgetsBelow,basis:"auto",shrink:1,minSize:0}],{component:options.pendingMessages,basis:"auto",shrink:1,minSize:0},{component:options.footer,basis:"auto",shrink:1,minSize:0}])';
const bundleChanged = patchFile(bundle, [
  { label: "bundled viewport", variants: [stockBundle, firstPatchBundle, previousBundle, currentBundle, inlineCurrentBundle], desired: desiredBundle },
  { label: "bundled responsive right panel", variants: [staticBundleRoot], desired: responsiveBundleRoot },
  {
    label: "pending-message height",
    variants: [
      'if(steeringMessages.length>0||followUpMessages.length>0){this.pendingMessagesContainer.addChild(new Spacer(1));for(let message of steeringMessages){let text=theme.fg("dim",`Steering: ${message}`);this.pendingMessagesContainer.addChild(new TruncatedText(text,1,0))}for(let message of followUpMessages){let text=theme.fg("dim",`Follow-up: ${message}`);this.pendingMessagesContainer.addChild(new TruncatedText(text,1,0))}let dequeueHint=this.getAppKeyDisplay("app.message.dequeue"),hintText=theme.fg("dim",`\\u21B3 ${dequeueHint} to edit all queued messages`);this.pendingMessagesContainer.addChild(new TruncatedText(hintText,1,0))}',
    ],
    desired: 'if(steeringMessages.length>0||followUpMessages.length>0){let message=[...steeringMessages,...followUpMessages].at(-1);this.pendingMessagesContainer.addChild(new TruncatedText(theme.fg("dim",`Pending: ${message}`),1,0))}',
  },
  {
    label: "tools pending-chat line",
    variants: [
      'return[theme.fg("accent",truncateToWidth("Tools",width)),...lines.map(line=>theme.fg("dim",line)),theme.fg("dim",truncateToWidth(`Running: ${running.join(", ")||"none"}`,width))]},invalidate:()=>{}',
    ],
    desired: 'return[...lines.map(line=>theme.fg("dim",line)),theme.fg("dim",truncateToWidth(`Running: ${running.join(", ")||"none"}`,width))]},invalidate:()=>{}',
  },
]);

console.log(prettyChanged || bundleChanged
  ? `Installed standard right-panel TUI layout in ${root}`
  : `Standard right-panel TUI layout is already installed in ${root}`);
console.log("Restart Pi to use the layout.");
