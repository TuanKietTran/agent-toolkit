#!/usr/bin/env python3
"""Autonomous options briefing for System 1 (the orchestrator).

Claude plays the chief of staff: it reasons at xhigh effort over a task and
returns a board-style briefing (3-4 genuinely different options, trade-offs, a
recommendation, the assumptions it made, and a rule for choosing). The briefing
is then posted to the System 1 API, which picks and runs on its own. Nobody is
asked anything in between.

    system1_client.py options "task" [--context FILE] [--no-send] [--json] [--dry-run]
    system1_client.py send briefing.json [--choose ID] [--dry-run]
    system1_client.py template            # skeleton briefing to fill in by hand (no API key needed)
    system1_client.py pick --situation new --complexity medium [...]   # System One model pick

Env: ANTHROPIC_API_KEY (or `ant auth login`; `options` only), SYSTEM1_API_URL, SYSTEM1_API_KEY (optional),
SYSTEM1_PICK_URL (`pick`; default is the local llama-swap passthrough to System One).
SYSTEM1_API_URL may also be `file:PATH`: the payload is appended as one JSON line to that file, which a
manager agent reads as its inbox.

Only the standard library is needed except for `options`, which imports `anthropic` when it runs.
"""
from __future__ import annotations

import argparse
import json
import os
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

MODEL = "claude-opus-5-5"
EFFORT = "xhigh"

# System One's model-pick endpoint as reached through llama-swap. Plain `/v1/decide` is a 404 there.
DEFAULT_PICK_URL = "http://127.0.0.1:8600/upstream/system-one/v1/decide"

# Hard rule: System 1 never decides permissions, approvals, consent, grants or allow/deny. The briefing's
# decision and option titles are what is being decided, so they are checked before anything is sent.
PERMISSION_RE = re.compile(
    r"\b(permissions?|approv(?:e|es|ed|al|als)|consents?|grant(?:s|ed|ing)?|den(?:y|ies|ied)|allow-?lists?|authori[sz]e[sd]?)\b",
    re.IGNORECASE,
)

NO_API_HELP = (
    "Cannot generate the briefing: {why}. Do not stop and do not ask anyone: write the briefing yourself in "
    "the same shape (`system1_client.py template` prints a skeleton), then run `system1_client.py send FILE`."
)

SYSTEM = """\
You are the chief of staff to System 1, an orchestrator that coordinates agents and tools. \
System 1 acts on whatever it is told, and it runs unattended: no human will answer a question \
once it starts. Your job is to hand it a real decision the way a C-level executive briefs a \
board: the decision, the options, the trade-offs, a recommendation, and a rule for choosing.

- Offer 3 or 4 options that differ in strategy (scope, sequencing, build vs buy, depth vs \
speed), not in wording. One may be the minimal/do-less option.
- State cost, time to first value, risk and reversibility for each, in terms a manager can \
compare at a glance. Say which downside would hurt most, not every downside.
- Be concrete about what System 1 would actually do under each option: the agents or tools \
it would start and the order, and what it falls back to if a step fails.
- Resolve ambiguity yourself. Where the task leaves something open, pick the most reasonable \
reading and record it as an assumption. Never hand System 1 a question for a human.
- Recommend exactly one option and justify it against the others in two or three sentences.
- Give selection guidance: the rule System 1 should apply to choose among the options on its \
own, including when to prefer a different option than the recommended one. Include how it \
answers the questions its own workers will raise: it decides them itself (default: the smaller, \
more reversible reading, recorded as an assumption) and never hands one to a human.
- Never offer an option whose decision is about permissions, approvals, consent, grants or \
allow/deny, and never plan around answering a permission prompt: System 1 does not decide those. \
If the task contains one, record in assumptions that it is held as blocked and plan the work \
around it.
"""

LEVELS = ["low", "medium", "high"]

BRIEFING_SCHEMA = {
    "type": "object",
    "properties": {
        "decision": {"type": "string"},
        "situation": {"type": "string"},
        "assumptions": {"type": "array", "items": {"type": "string"}},
        "options": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "id": {"type": "string"},
                    "title": {"type": "string"},
                    "summary": {"type": "string"},
                    "system1_plan": {"type": "array", "items": {"type": "string"}},
                    "fallback": {"type": "string"},
                    "cost": {"type": "string", "enum": LEVELS},
                    "time_to_value": {"type": "string"},
                    "risk": {"type": "string", "enum": LEVELS},
                    "reversibility": {"type": "string", "enum": LEVELS},
                    "upsides": {"type": "array", "items": {"type": "string"}},
                    "downsides": {"type": "array", "items": {"type": "string"}},
                },
                "required": [
                    "id", "title", "summary", "system1_plan", "fallback", "cost",
                    "time_to_value", "risk", "reversibility", "upsides", "downsides",
                ],
                "additionalProperties": False,
            },
        },
        "recommendation": {
            "type": "object",
            "properties": {"option_id": {"type": "string"}, "rationale": {"type": "string"}},
            "required": ["option_id", "rationale"],
            "additionalProperties": False,
        },
        "selection_guidance": {"type": "string"},
    },
    "required": [
        "decision", "situation", "assumptions", "options", "recommendation", "selection_guidance",
    ],
    "additionalProperties": False,
}


class SendError(Exception):
    pass


def generate_briefing(task: str, context: str = "") -> dict:
    try:
        import anthropic
    except ImportError:
        print(NO_API_HELP.format(why="the `anthropic` package is not installed (pip install -r client/requirements.txt)"), file=sys.stderr)
        sys.exit(2)
    try:
        client = anthropic.Anthropic()
    except Exception as e:  # missing ANTHROPIC_API_KEY raises here
        print(NO_API_HELP.format(why=f"no Anthropic credentials ({e})"), file=sys.stderr)
        sys.exit(2)
    prompt = f"<task>\n{task}\n</task>"
    if context:
        prompt += f"\n\n<context>\n{context}\n</context>"

    try:
        with client.beta.messages.stream(
            model=MODEL,
            max_tokens=64000,
            betas=["server-side-fallback-2026-07-01"],
            fallbacks="default",
            thinking={"type": "adaptive", "display": "summarized"},
            output_config={
                "effort": EFFORT,
                "format": {"type": "json_schema", "schema": BRIEFING_SCHEMA},
            },
            system=SYSTEM,
            messages=[{"role": "user", "content": prompt}],
        ) as stream:
            message = stream.get_final_message()
    except anthropic.APIStatusError as e:
        sys.exit(f"Anthropic API error {e.status_code}: {e.message}")
    except anthropic.APIConnectionError as e:
        sys.exit(f"Could not reach the Anthropic API: {e}")

    if message.stop_reason == "refusal":
        sys.exit(f"Model refused the request: {message.stop_details}")
    if message.stop_reason == "max_tokens":
        sys.exit("Briefing was cut off at max_tokens; narrow the task or raise the limit.")

    text = next((b.text for b in message.content if b.type == "text"), "")
    briefing = json.loads(text)
    ids = {o["id"] for o in briefing["options"]}
    if briefing["recommendation"]["option_id"] not in ids:
        sys.exit("Model recommended an option id that is not in the option list.")
    return briefing


TEMPLATE = {
    "decision": "TODO: the one decision, in a sentence",
    "situation": "TODO: two or three sentences of context a manager needs",
    "assumptions": ["TODO: every ambiguity you resolved yourself, one per line"],
    "options": [
        {
            "id": letter,
            "title": f"TODO: option {letter}",
            "summary": "TODO",
            "system1_plan": ["TODO: what runs, in order"],
            "fallback": "TODO: what happens if a step fails",
            "cost": "medium",
            "time_to_value": "TODO",
            "risk": "medium",
            "reversibility": "medium",
            "upsides": ["TODO"],
            "downsides": ["TODO: the one that hurts most"],
        }
        for letter in "ABC"
    ],
    "recommendation": {"option_id": "A", "rationale": "TODO: why A beats B and C, in two or three sentences"},
    "selection_guidance": "TODO: the rule for choosing, including how worker questions are answered "
    "(decide, smaller and more reversible reading, record the assumption; never pass a question to a human)",
}


def _strings(value):
    if isinstance(value, str):
        yield value
    elif isinstance(value, dict):
        for v in value.values():
            yield from _strings(v)
    elif isinstance(value, list):
        for v in value:
            yield from _strings(v)


def validate_briefing(briefing) -> list[str]:
    """Return a list of problems; an empty list means the briefing may be sent."""
    problems: list[str] = []
    if not isinstance(briefing, dict):
        return ["briefing must be a JSON object"]
    for key in BRIEFING_SCHEMA["required"]:
        if key not in briefing:
            problems.append(f"missing '{key}'")
    options = briefing.get("options")
    if not isinstance(options, list) or not 2 <= len(options) <= 5:
        problems.append("'options' must be a list of 2 to 5 options (3 or 4 is the aim)")
        options = []
    option_schema = BRIEFING_SCHEMA["properties"]["options"]["items"]
    ids = []
    for index, option in enumerate(options):
        if not isinstance(option, dict):
            problems.append(f"option #{index + 1} is not an object")
            continue
        for key in option_schema["required"]:
            if key not in option:
                problems.append(f"option #{index + 1} is missing '{key}'")
        for key in ("cost", "risk", "reversibility"):
            if option.get(key) not in LEVELS:
                problems.append(f"option #{index + 1} '{key}' must be one of {LEVELS}")
        ids.append(option.get("id"))
    recommendation = briefing.get("recommendation")
    if isinstance(recommendation, dict) and recommendation.get("option_id") not in ids:
        problems.append("recommendation.option_id is not one of the option ids")
    if any(s.strip().startswith("TODO") for s in _strings(briefing)):
        problems.append("the briefing still contains TODO placeholders")
    decided = [str(briefing.get("decision", ""))] + [str(o.get("title", "")) for o in options if isinstance(o, dict)]
    hit = next((m.group(0) for text in decided if (m := PERMISSION_RE.search(text))), None)
    if hit:
        problems.append(
            f"the decision or an option title is about permissions ('{hit}'). System 1 never decides permissions, "
            "approvals, consent, grants or allow/deny: handle it yourself or record it as blocked, "
            "and brief System 1 on the work around it"
        )
    return problems


def build_payload(briefing: dict, chosen: str | None) -> dict:
    payload = {
        # `kind` is the field System One's guard reads; without it a payload is silently treated as a
        # model pick and answered with 200 (a false success). `type` is kept for orchestrators that read it.
        "kind": "decision_options",
        "type": "decision_options",
        "mode": "autonomous",
        "briefing": briefing,
        "recommended_option_id": briefing["recommendation"]["option_id"],
    }
    if chosen:
        if chosen not in {o["id"] for o in briefing["options"]}:
            raise SendError(f"Unknown option id {chosen!r}.")
        payload["chosen_option_id"] = chosen
    return payload


def _file_sink_path(url: str) -> Path:
    if url.startswith("file://"):
        return Path(urllib.request.url2pathname(urllib.parse.unquote(urllib.parse.urlparse(url).path)))
    return Path(url[len("file:"):])


def _check_reply(body: str) -> None:
    """A model pick in reply to a briefing means the endpoint is System One's model-pick service."""
    try:
        data = json.loads(body)
    except ValueError:
        return
    if isinstance(data, dict) and data.get("kind") == "model_pick":
        raise SendError(
            "The endpoint answered with a model pick, so it is System One's model-pick service and it ignored "
            "the briefing. Point SYSTEM1_API_URL at an orchestrator (or a file: inbox), or use `pick` for model choices."
        )


def send_to_system1(briefing: dict, chosen: str | None = None, dry_run: bool = False) -> str:
    problems = validate_briefing(briefing)
    if problems:
        raise SendError("Refusing to send an invalid briefing: " + "; ".join(problems))
    payload = build_payload(briefing, chosen)
    if dry_run:
        return json.dumps(payload, indent=2)

    url = os.environ.get("SYSTEM1_API_URL")
    if not url:
        raise SendError("SYSTEM1_API_URL is not set.")
    if url.startswith("file:"):
        path = _file_sink_path(url)
        path.parent.mkdir(parents=True, exist_ok=True)
        with open(path, "a", encoding="utf-8") as sink:
            sink.write(json.dumps({"received_at": time.strftime("%Y-%m-%dT%H:%M:%S"), **payload}) + "\n")
        return f"queued in {path}"
    headers = {"Content-Type": "application/json"}
    if key := os.environ.get("SYSTEM1_API_KEY"):
        headers["Authorization"] = f"Bearer {key}"

    request = urllib.request.Request(url, data=json.dumps(payload).encode(), headers=headers, method="POST")
    try:
        with urllib.request.urlopen(request, timeout=60) as response:
            body = response.read().decode()
    except urllib.error.HTTPError as e:
        raise SendError(f"System 1 returned HTTP {e.code}: {e.read().decode(errors='replace')}")
    except urllib.error.URLError as e:
        raise SendError(f"Could not reach System 1 at {url}: {e.reason}")
    _check_reply(body)
    return body


def pick_model(args) -> str:
    """Ask System One for a model pick (the only decision kind it accepts)."""
    url = os.environ.get("SYSTEM1_PICK_URL", DEFAULT_PICK_URL)
    scenario: dict = {"kind": "model_pick", "situation": args.situation, "complexity_hint": args.complexity}
    if args.prev_model:
        scenario["prev_model"] = args.prev_model
    if args.context_tokens is not None:
        scenario["context_tokens"] = args.context_tokens
    if args.available:
        scenario["available"] = [m.strip() for m in args.available.split(",") if m.strip()]
    headroom = {k: v for k, v in (("claude", args.headroom_claude), ("codex", args.headroom_codex)) if v is not None}
    if headroom:
        scenario["headroom"] = headroom
    request = urllib.request.Request(
        url, data=json.dumps(scenario).encode(), headers={"Content-Type": "application/json"}, method="POST"
    )
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            return response.read().decode()
    except urllib.error.HTTPError as e:
        raise SendError(f"System One returned HTTP {e.code}: {e.read().decode(errors='replace')}")
    except urllib.error.URLError as e:
        raise SendError(
            f"Could not reach System One at {url}: {e.reason}. Set SYSTEM1_PICK_URL, or call "
            "system_one.client.decide() in process, which falls back to the local policy."
        )


def render(briefing: dict) -> str:
    rec = briefing["recommendation"]["option_id"]
    lines = [f"DECISION: {briefing['decision']}", briefing["situation"], ""]
    for o in briefing["options"]:
        star = "  <- recommended" if o["id"] == rec else ""
        lines += [
            f"[{o['id']}] {o['title']}{star}",
            f"    {o['summary']}",
            f"    cost={o['cost']}  risk={o['risk']}  reversibility={o['reversibility']}  "
            f"time to value: {o['time_to_value']}",
            f"    + {'; '.join(o['upsides'])}",
            f"    - {'; '.join(o['downsides'])}",
            f"    fallback: {o['fallback']}",
            "",
        ]
    lines.append(f"RECOMMENDATION: {rec}. {briefing['recommendation']['rationale']}")
    lines.append(f"SELECTION GUIDANCE: {briefing['selection_guidance']}")
    if briefing["assumptions"]:
        lines += ["", "ASSUMPTIONS:"] + [f"  * {a}" for a in briefing["assumptions"]]
    return "\n".join(lines)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawTextHelpFormatter)
    sub = parser.add_subparsers(dest="cmd", required=True)

    opts = sub.add_parser("options", help="generate a briefing and send it to System 1")
    opts.add_argument("task")
    opts.add_argument("--context", help="file with background to include")
    opts.add_argument("--json", action="store_true", help="print {briefing, system1_response, error} as JSON")
    opts.add_argument("--no-send", action="store_true", help="only generate; do not post to System 1")
    opts.add_argument("--dry-run", action="store_true", help="print the payload instead of posting")

    snd = sub.add_parser("send", help="post a saved briefing JSON to System 1")
    snd.add_argument("briefing", help="path to a briefing JSON file ('-' for stdin)")
    snd.add_argument("--choose", help="force System 1 to use this option id")
    snd.add_argument("--dry-run", action="store_true")

    sub.add_parser("template", help="print a skeleton briefing to fill in by hand (no API key needed)")

    pk = sub.add_parser("pick", help="ask System One (local) for a model pick; it decides model picks only")
    pk.add_argument("--situation", choices=["new", "existing", "continuing"], required=True)
    pk.add_argument("--complexity", choices=["low", "medium", "high"], required=True)
    pk.add_argument("--prev-model", default="")
    pk.add_argument("--context-tokens", type=int)
    pk.add_argument("--available", help="comma list of model ids that may be picked (default: System One's catalog)")
    pk.add_argument("--headroom-claude", type=float, help="share of Claude quota still free, 0 to 1")
    pk.add_argument("--headroom-codex", type=float, help="share of Codex quota still free, 0 to 1")

    args = parser.parse_args()

    if args.cmd == "template":
        print(json.dumps(TEMPLATE, indent=2))
        return

    if args.cmd == "pick":
        try:
            print(pick_model(args))
        except SendError as e:
            sys.exit(str(e))
        return

    if args.cmd == "send":
        raw = sys.stdin.read() if args.briefing == "-" else Path(args.briefing).read_text(encoding="utf-8-sig")
        try:
            print(send_to_system1(json.loads(raw), args.choose, args.dry_run))
        except (SendError, ValueError) as e:
            sys.exit(str(e))
        return

    context = Path(args.context).read_text(encoding="utf-8") if args.context else ""
    briefing = generate_briefing(args.task, context)
    reply, error = None, None
    if not args.no_send:
        try:
            reply = send_to_system1(briefing, None, args.dry_run)
        except SendError as e:
            error = str(e)

    if args.json:
        print(json.dumps({"briefing": briefing, "system1_response": reply, "error": error}))
    else:
        print(render(briefing))
        if reply is not None:
            print("\n--- System 1 response ---\n" + reply)
        if error:
            print(f"\nNOT SENT: {error}", file=sys.stderr)
    sys.exit(1 if error else 0)


if __name__ == "__main__":
    main()
