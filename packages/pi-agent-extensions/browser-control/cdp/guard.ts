import type { ClickTargetFacts } from "./contract.ts";

const TERMS = ["place order", "sign up", "submit", "pay", "buy", "purchase", "confirm", "send", "post", "publish", "delete", "checkout", "subscribe", "register", "apply"];
const NON_CLICK_ROLES = new Set(["textbox", "searchbox", "combobox", "listbox", "slider", "spinbutton", "heading", "img", "text", "paragraph"]);

export function isSubmitLike(t: ClickTargetFacts): boolean {
  if ((t.inputType ?? "").toLowerCase() === "submit") return true;
  if (NON_CLICK_ROLES.has((t.role ?? "").toLowerCase())) return false;
  const name = (t.name ?? "").toLowerCase().replace(/\s+/g, " ").trim();
  if (!name) return false;
  return TERMS.some((term) => new RegExp("(^|[^a-z])" + term.replace(/ /g, "\\s+") + "([^a-z]|$)").test(name));
}
