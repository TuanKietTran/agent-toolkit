"""Run M3b/M4, export the student, and write the honest M3/M4 report."""

from __future__ import annotations

import json
import statistics
import time
from collections import Counter, defaultdict
from pathlib import Path
from typing import Any

from .policy import MODEL_SPECS, TIER_MODELS, pick_model
from .scenarios import all_scenarios, generate_scenarios, write_scenarios
from .student import StudentPredictor, load_predictor, train_student


def _accuracy(values: list[bool]) -> float | None:
    return round(sum(values) / len(values), 6) if values else None


def _percentile(values: list[int], percentile: float) -> float | None:
    if not values:
        return None
    ordered = sorted(values)
    index = min(len(ordered) - 1, round((len(ordered) - 1) * percentile))
    return ordered[index] / 1000.0


def _evaluate(cases: list[dict[str, Any]], predictor: StudentPredictor) -> dict[str, Any]:
    agreements: list[bool] = []
    by_situation: dict[str, list[bool]] = defaultdict(list)
    by_rule: dict[str, list[bool]] = defaultdict(list)
    confusion: Counter[tuple[str, str]] = Counter()
    degraded_levels: Counter[int] = Counter()
    latency_policy: list[int] = []
    latency_student: list[int] = []
    for case in cases:
        policy_start = time.perf_counter_ns()
        expected = pick_model(case)
        latency_policy.append(time.perf_counter_ns() - policy_start)
        student_start = time.perf_counter_ns()
        actual = predictor.predict(case)
        latency_student.append(time.perf_counter_ns() - student_start)
        agreement = actual.model == expected.model
        agreements.append(agreement)
        by_situation[case["situation"]].append(agreement)
        by_rule[expected.rule].append(agreement)
        confusion[(expected.model, actual.model)] += 1
        degraded_levels[expected.degraded_level] += 1
    return {
        "n": len(cases),
        "agreement": _accuracy(agreements),
        "agreement_by_situation": {key: _accuracy(value) for key, value in sorted(by_situation.items())},
        "agreement_by_rule": {key: _accuracy(value) for key, value in sorted(by_rule.items())},
        "confusion_matrix": {f"{expected}->{actual}": count for (expected, actual), count in sorted(confusion.items())},
        "fallbacks": predictor.fallback_count,
        "fallback_rate": round(predictor.fallback_count / len(cases), 6) if cases else None,
        "policy_degraded_levels": dict(sorted(degraded_levels.items())),
        "policy_degraded_share": round(sum(count for level, count in degraded_levels.items() if level > 0) / len(cases), 6) if cases else 0.0,
        "latency_microseconds": {
            "policy_median": _percentile(latency_policy, 0.5),
            "policy_p99": _percentile(latency_policy, 0.99),
            "student_median": _percentile(latency_student, 0.5),
            "student_p99": _percentile(latency_student, 0.99),
        },
    }


def _replay_real(rows: list[dict[str, Any]]) -> dict[str, Any]:
    by_session: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for row in rows:
        by_session[row["session_id_hash"]].append(row)
    hold: Counter[tuple[str, str]] = Counter()
    hold_total: Counter[tuple[str, str]] = Counter()
    new_match: Counter[str] = Counter()
    new_total: Counter[str] = Counter()
    new_union_match = 0
    new_union_total = 0
    for session_rows in by_session.values():
        previous = ""
        for row in session_rows:
            hints = ("low", "medium", "high")
            source_available = sorted(
                model for model, spec in MODEL_SPECS.items()
                if row["source"] == "pi" or spec.provider == "claude"
            )
            picks = set()
            for hint in hints:
                case = {
                    "situation": row["situation"],
                    "prev_model": previous,
                    "idle_gap_minutes": row.get("idle_gap_minutes") or 0.0,
                    "complexity_hint": hint,
                    "context_tokens": row.get("context_size_tokens") or 0,
                    "needs_images": bool(row.get("image_present")),
                    "available": source_available,
                    "headroom": {"claude": 1.0, "codex": 1.0},
                    "hard_cap": 0.9,
                }
                decision = pick_model(case)
                picks.add(decision.model)
                if row["situation"] in {"continuing", "existing"}:
                    key = (row["source"], hint)
                    hold_total[key] += 1
                    hold[key] += int(decision.model == row["model"])
                elif row["situation"] == "new":
                    new_total[hint] += 1
                    new_match[hint] += int(decision.model == row["model"])
            if row["situation"] == "new":
                new_union_total += 1
                new_union_match += int(row["model"] in picks)
            previous = row["model"]
    return {
        "continuing_existing_policy_holds_actual": {
            hint: {"n": sum(hold_total[(source, hint)] for source in ("claude", "pi")), "holds": sum(hold[(source, hint)] for source in ("claude", "pi")), "rate": round(sum(hold[(source, hint)] for source in ("claude", "pi")) / sum(hold_total[(source, hint)] for source in ("claude", "pi")), 6) if sum(hold_total[(source, hint)] for source in ("claude", "pi")) else 0.0}
            for hint in ("low", "medium", "high")
        },
        "continuing_existing_policy_holds_actual_by_source": {
            f"{source}:{hint}": {"n": hold_total[(source, hint)], "holds": hold[(source, hint)], "rate": round(hold[(source, hint)] / hold_total[(source, hint)], 6) if hold_total[(source, hint)] else 0.0}
            for source in ("claude", "pi") for hint in ("low", "medium", "high")
        },
        "new_actual_model_matches_policy_pick": {
            hint: {"n": new_total[hint], "matches": new_match[hint], "rate": round(new_match[hint] / new_total[hint], 6) if new_total[hint] else 0.0}
            for hint in ("low", "medium", "high")
        },
        "new_actual_model_in_union_of_three_hints": {"n": new_union_total, "matches": new_union_match, "rate": round(new_union_match / new_union_total, 6) if new_union_total else 0.0},
        "note": "Claude replay availability is Claude-only; pi replay allows the full catalog. Complexity hints and full headroom are caller-supplied/synthetic.",
    }


def build_report(output_dir: Path = Path("data"), report_path: Path = Path("REPORT.md")) -> dict[str, Any]:
    groups = generate_scenarios()
    write_scenarios(groups, output_dir / "scenarios.jsonl")
    train_student(groups["train"], output_dir / "student_model.json")
    predictor = load_predictor(output_dir / "student_model.json")
    test_metrics = _evaluate(groups["test"], predictor)
    test_fallbacks = predictor.fallback_count
    ood_predictor = load_predictor(output_dir / "student_model.json")
    ood_metrics = _evaluate(groups["ood"], ood_predictor)
    rows = [json.loads(line) for line in (output_dir / "decision_points.jsonl").open("r", encoding="utf-8") if line.strip()]
    summary = json.loads((output_dir / "inventory_summary.json").read_text(encoding="utf-8"))
    replay = _replay_real(rows)
    total_synthetic = sum(len(items) for items in groups.values())
    report = {
        "policy": "explicit R1/R2/R3 policy; not learned from owner behaviour",
        "student": "decision tree distilled from policy labels; JSON-only runtime inference",
        "scenario_counts": {key: len(value) for key, value in groups.items()},
        "scenario_situation_balance": {
            key: dict(Counter(case["situation"] for case in cases)) for key, cases in groups.items()
        },
        "test": test_metrics,
        "ood": ood_metrics,
        "real_replay": replay,
        "real_inventory_rows": summary.get("decision_points"),
        "student_test_fallbacks": test_fallbacks,
        "limits": [
            "The student is supervised by the explicit policy, not by the owner's behaviour.",
            "complexity_hint is supplied by the caller; this slice does not derive it from prompts.",
            "quota headroom is synthetic for scenarios and replay; no live logger was started.",
            "The real history has too few switches to evaluate learned switching behaviour.",
        ],
    }
    lines = [
        "# M3/M4 Report",
        "",
        "This is policy distillation, not learning the owner's behaviour. The student is trained on labels emitted by the explicit R1/R2/R3 policy.",
        "No prompt text is used or stored. No live logger was started. Every successful decision is a concrete usable model; NoModelAvailable is an error condition, not a label.",
        "The student is slower than the hand-written policy in this slice, so this proves the harness, not a speed gain.",
        "",
        "## Scenarios",
        f"- Counts: {report['scenario_counts']}; situation balance: {report['scenario_situation_balance']}.",
        f"- Test agreement: {test_metrics['agreement']}; OOD agreement: {ood_metrics['agreement'] }.",
        f"- Test fallback rate: {test_metrics['fallback_rate']}; OOD fallback rate: {ood_metrics['fallback_rate'] }.",
        f"- Policy degraded levels test: {test_metrics['policy_degraded_levels']} (share {test_metrics['policy_degraded_share']}); OOD: {ood_metrics['policy_degraded_levels']} (share {ood_metrics['policy_degraded_share']}).",
        f"- Test agreement by situation: {test_metrics['agreement_by_situation']}.",
        f"- Test agreement by policy rule: {test_metrics['agreement_by_rule']}.",
        f"- Test confusion matrix (policy -> student): {test_metrics['confusion_matrix']}.",
        f"- OOD confusion matrix (policy -> student): {ood_metrics['confusion_matrix']}.",
        "",
        "## Latency (microseconds per decision, pure Python JSON inference)",
        f"- Test policy median/p99: {test_metrics['latency_microseconds']['policy_median']} / {test_metrics['latency_microseconds']['policy_p99']}.",
        f"- Test student median/p99: {test_metrics['latency_microseconds']['student_median']} / {test_metrics['latency_microseconds']['student_p99']}.",
        f"- OOD policy median/p99: {ood_metrics['latency_microseconds']['policy_median']} / {ood_metrics['latency_microseconds']['policy_p99']}.",
        f"- OOD student median/p99: {ood_metrics['latency_microseconds']['student_median']} / {ood_metrics['latency_microseconds']['student_p99']}.",
        "",
        "## Replay of real metadata inventory",
        f"- Decision points replayed: {report['real_inventory_rows']}.",
        f"- Continuing/existing policy holds actual model after catalog/source fix: {replay['continuing_existing_policy_holds_actual']}.",
        f"- New exact policy matches by supplied hint: {replay['new_actual_model_matches_policy_pick']}.",
        f"- New actual model in union of low/medium/high picks: {replay['new_actual_model_in_union_of_three_hints']}.",
        "- Claude replay availability is Claude-only; pi replay allows the full catalog. This replay is descriptive only: the hint and quota headroom are not inferred from prompts and are synthetic/caller-supplied.",
        "",
        "## Limits",
        *[f"- {item}" for item in report["limits"]],
        "",
    ]
    report_path.write_text("\n".join(lines), encoding="utf-8")
    (output_dir / "m3_m4_metrics.json").write_text(json.dumps(report, sort_keys=True, indent=2) + "\n", encoding="utf-8")
    return report


def main() -> int:
    report = build_report()
    print(json.dumps({"test_agreement": report["test"]["agreement"], "ood_agreement": report["ood"]["agreement"], "real_rows": report["real_inventory_rows"]}, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
