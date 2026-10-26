"""Metadata-only reconciliation against the commander's timestamp references."""

from __future__ import annotations

import argparse
import json
import statistics
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

REFERENCE = {
    "same_file_gaps_ge_30": "19",
    "max_gap_minutes": "~24480",
    "assistant_to_next_user_n": "2552",
    "assistant_to_next_user_median_seconds": "1.2",
    "assistant_to_next_user_p99_minutes": "2.0",
    "assistant_to_next_user_max_minutes": "189.5",
    "assistant_to_next_user_ge_30": "1",
    "assistant_to_next_user_ge_5": "7",
}


def _timestamp(value: Any) -> float | None:
    if not isinstance(value, str):
        return None
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
        if parsed.tzinfo is None:
            parsed = parsed.replace(tzinfo=timezone.utc)
        return parsed.timestamp()
    except ValueError:
        return None


def _is_main(record: dict[str, Any]) -> bool:
    return record.get("isSidechain") is not True


def raw_metrics(root: Path) -> dict[str, Any]:
    timestamped_gaps: list[float] = []
    assistant_to_user: list[float] = []
    for path in sorted(root.rglob("*.jsonl")):
        records: list[dict[str, Any]] = []
        with path.open("r", encoding="utf-8", errors="replace") as handle:
            for line in handle:
                try:
                    record = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if isinstance(record, dict):
                    records.append(record)
        timestamped = [_timestamp(record.get("timestamp")) for record in records]
        timestamped = [value for value in timestamped if value is not None]
        timestamped_gaps.extend(b - a for a, b in zip(timestamped, timestamped[1:]))
        for index, record in enumerate(records):
            if record.get("type") != "assistant" or not _is_main(record):
                continue
            before = _timestamp(record.get("timestamp"))
            if before is None:
                continue
            for following in records[index + 1 :]:
                if following.get("type") == "user" and _is_main(following):
                    after = _timestamp(following.get("timestamp"))
                    if after is not None:
                        assistant_to_user.append(after - before)
                    break
    p99 = statistics.quantiles(assistant_to_user, n=100)[98] if len(assistant_to_user) >= 100 else None
    return {
        "same_file_gaps_ge_30": sum(gap >= 1800 for gap in timestamped_gaps),
        "max_gap_minutes": max(timestamped_gaps, default=0) / 60,
        "assistant_to_next_user_n": len(assistant_to_user),
        "assistant_to_next_user_median_seconds": statistics.median(assistant_to_user) if assistant_to_user else None,
        "assistant_to_next_user_p99_minutes": p99 / 60 if p99 is not None else None,
        "assistant_to_next_user_max_minutes": max(assistant_to_user, default=0) / 60,
        "assistant_to_next_user_ge_30": sum(gap >= 1800 for gap in assistant_to_user),
        "assistant_to_next_user_ge_5": sum(gap >= 300 for gap in assistant_to_user),
    }


def reconcile(root: Path, summary_path: Path) -> dict[str, Any]:
    raw = raw_metrics(root)
    summary = json.loads(summary_path.read_text(encoding="utf-8"))
    return {"reference": REFERENCE, "ours": raw, "inventory": {
        "decision_points": summary.get("decision_points"),
        "existing": summary.get("records_per_situation", {}).get("existing", 0),
        "sidechain_candidate_assistant_events": summary.get("sidechain_candidate_assistant_events", 0),
        "junk_model_events": summary.get("junk_model_events", 0),
    }}


def _show(value: Any) -> str:
    return "—" if value is None else f"{value:.3f}" if isinstance(value, float) else str(value)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Reconcile timestamp counts without reading message text")
    parser.add_argument("--claude-root", type=Path, default=Path(r"C:/Users/cafe/.claude/projects"))
    parser.add_argument("--summary", type=Path, default=Path("data/inventory_summary.json"))
    args = parser.parse_args(argv)
    result = reconcile(args.claude_root, args.summary)
    ours = result["ours"]
    for key in REFERENCE:
        print(f"{key}: ours={_show(ours[key])} reference={REFERENCE[key]}")
    inv = result["inventory"]
    print(f"inventory decision_points: ours={inv['decision_points']} existing={inv['existing']} sidechain_candidates={inv['sidechain_candidate_assistant_events']} junk_models={inv['junk_model_events']}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
