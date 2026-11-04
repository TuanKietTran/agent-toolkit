"""M2 model-pick baselines evaluated on session-held-out inventory rows."""

from __future__ import annotations

import argparse
import json
from collections import Counter, defaultdict
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


def _time_key(value: Any) -> float:
    if not isinstance(value, str):
        return float("-inf")
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
        if parsed.tzinfo is None:
            parsed = parsed.replace(tzinfo=timezone.utc)
        return parsed.timestamp()
    except ValueError:
        return float("-inf")


def _metric(correct: int, total: int) -> dict[str, Any]:
    return {"n": total, "correct": correct, "accuracy": round(correct / total, 6) if total else None}


def evaluate(rows: list[dict[str, Any]]) -> dict[str, Any]:
    train = [row for row in rows if row.get("split") == "train"]
    test = [row for row in rows if row.get("split") == "test"]
    if not train:
        raise ValueError("no training rows")
    majority_model = sorted(Counter(row["model"] for row in train).items(), key=lambda item: (-item[1], item[0]))[0][0]

    by_session: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for row in test:
        by_session[row["session_id_hash"]].append(row)
    ordered_test: list[tuple[dict[str, Any], str | None]] = []
    for session_rows in by_session.values():
        previous: str | None = None
        for row in sorted(enumerate(session_rows), key=lambda pair: (_time_key(pair[1].get("timestamp")), pair[0])):
            current = row[1]
            ordered_test.append((current, previous))
            previous = current["model"]

    results: dict[str, dict[str, dict[str, Any]]] = {}
    for baseline in ("majority", "keep_previous_model"):
        buckets: dict[str, list[bool]] = {"changed": [], "held": [], "first": []}
        for row, previous in ordered_test:
            category = "first" if previous is None else "changed" if row["model"] != previous else "held"
            prediction = majority_model if baseline == "majority" or previous is None else previous
            buckets[category].append(prediction == row["model"])
        results[baseline] = {
            category: _metric(sum(values), len(values)) for category, values in buckets.items()
        }
        all_values = [value for values in buckets.values() for value in values]
        results[baseline]["all"] = _metric(sum(all_values), len(all_values))

    return {
        "task": "predict actual model used at each model-run decision point",
        "held_out_split": "test",
        "train_rows": len(train),
        "test_rows": len(test),
        "train_sessions": len({row["session_id_hash"] for row in train}),
        "test_sessions": len({row["session_id_hash"] for row in test}),
        "majority_model_from_train": majority_model,
        "test_actual_model_changed": sum(previous is not None and row["model"] != previous for row, previous in ordered_test),
        "test_actual_model_held": sum(previous is not None and row["model"] == previous for row, previous in ordered_test),
        "test_first_decision_points": sum(previous is None for _, previous in ordered_test),
        "baselines": results,
        "interpretation": "changed, held, and first categories are reported separately; first keep-previous predictions fall back to the training majority",
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Evaluate M2 model-pick baselines")
    parser.add_argument("--input", type=Path, default=Path("data/decision_points.jsonl"))
    parser.add_argument("--output", type=Path, default=Path("data/baseline_results.json"))
    args = parser.parse_args(argv)
    rows = [json.loads(line) for line in args.input.open("r", encoding="utf-8") if line.strip()]
    results = evaluate(rows)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    with args.output.open("w", encoding="utf-8", newline="\n") as handle:
        json.dump(results, handle, sort_keys=True, indent=2)
        handle.write("\n")
    print(json.dumps({name: result["all"] for name, result in results["baselines"].items()}, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
