const state = document.querySelector("#state");
const list = document.querySelector("#targets");
const button = (label, fn) => { const el = document.createElement("button"); el.textContent = label; el.addEventListener("click", fn); return el; };
async function refresh() {
  const model = await chrome.runtime.sendMessage({ type: "get-state" });
  state.textContent = model.connected ? "Native host connected. Sites are denied until explicitly allowed." : "Native host not connected.";
  list.replaceChildren();
  for (const target of model.targets || []) {
    const row = document.createElement("section"); row.className = "target";
    const title = document.createElement("strong"); title.textContent = target.title || "(untitled tab)";
    const origin = document.createElement("div"); origin.className = "muted"; origin.textContent = target.origin;
    row.append(title, origin);
    const allowed = (model.grants || []).includes(target.id);
    row.append(button(allowed ? "Revoke" : `Allow ${target.origin}`, async () => {
      await chrome.runtime.sendMessage(allowed
        ? { type: "revoke", targetId: target.id }
        : { type: "grant", targetId: target.id, origin: target.origin });
      await refresh();
    }));
    list.append(row);
  }
}
document.querySelector("#connect").addEventListener("click", async () => {
  await chrome.runtime.sendMessage({ type: "connect" });
  state.textContent = "Connecting to native host…";
});
document.querySelector("#refresh").addEventListener("click", async () => {
  await chrome.runtime.sendMessage({ type: "targets-refresh" });
  setTimeout(refresh, 250);
});
chrome.runtime.onMessage.addListener(message => { if (message?.type === "helper-state") void refresh(); });
void refresh();
