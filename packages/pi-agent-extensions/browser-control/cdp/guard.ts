import type { ClickTargetFacts } from "./contract.ts";

const TERMS = ["place order", "sign up", "submit", "pay", "buy", "purchase", "confirm", "send", "post", "publish", "delete", "checkout", "subscribe", "register", "apply"];
/** Still consequential inside a search form. */
const SEARCH_FORM_TERMS = ["place order", "pay", "buy", "purchase", "delete", "checkout", "subscribe"];
const NON_CLICK_ROLES = new Set(["textbox", "searchbox", "combobox", "listbox", "slider", "spinbutton", "heading", "img", "text", "paragraph"]);

function named(name: string, terms: string[]): boolean {
  return terms.some((term) => new RegExp("(^|[^a-z])" + term.replace(/ /g, "\\s+") + "([^a-z]|$)").test(name));
}

export function isSubmitLike(t: ClickTargetFacts): boolean {
  const name = (t.name ?? "").toLowerCase().replace(/\s+/g, " ").trim();
  // Submitting a search form only runs a query; it needs no confirmation unless it is named like a payment/deletion.
  if (t.inSearchForm) return !!name && named(name, SEARCH_FORM_TERMS);
  if ((t.inputType ?? "").toLowerCase() === "submit") return true;
  if (NON_CLICK_ROLES.has((t.role ?? "").toLowerCase())) return false;
  if (!name) return false;
  return named(name, TERMS);
}
