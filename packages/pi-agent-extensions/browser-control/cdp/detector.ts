import type { Detection, PageFacts, StopReason } from "./contract.ts";

function hit(hay: string, re: RegExp): string | undefined { const m = hay.match(re); return m ? m[0] : undefined; }
function found(reason: StopReason, evidence?: string): Detection { return { blocked: true, reason, evidence }; }

export function detectBlock(page: PageFacts): Detection {
  const url = (page.url ?? "").toLowerCase();
  const hay = ((page.title ?? "") + "\n" + (page.text ?? "")).toLowerCase();
  let e: string | undefined;
  if ((e = hit(hay, /unusual traffic|unusual activity (from|on) (your|this)|detected unusual/))) return found("unusual_traffic", e);
  if ((e = hit(hay, /\b429\b|too many requests|rate limit|rate-limited|request limit exceeded/))) return found("rate_limit", e);
  if ((e = hit(hay, /just a moment|checking your browser|cloudflare[^\n]{0,40}(challenge|check|protection)|challenge-platform|attention required|ddos protection/))) return found("bot_check", e);
  if ((e = hit(hay, /captcha|recaptcha|hcaptcha|verify you are human|are you human|i'?m not a robot|not a robot|human verification|prove you are human|security puzzle/))) return found("captcha", e);
  if (/\/(login|log-in|signin|sign-in|sign_in|auth)(\/|$|\?|#)/.test(url) || /(^|\.)accounts\./.test(url)) return found("login_wall", url);
  const loginWords = /sign in|log in|login|username/.test(hay);
  if ((e = hit(hay, /sign in to continue|log in to continue|you must (sign|log) in|please (sign|log) in/))) return found("login_wall", e);
  if (loginWords && /password/.test(hay)) return found("login_wall", "login wording + password");
  return { blocked: false };
}
