"""Deterministic synthetic metadata scenarios for policy distillation."""

from __future__ import annotations

import argparse
import json
import random
from pathlib import Path
from typing import Any

from .policy import MODEL_SPECS, TIER_MODELS

SITUATIONS = ("new", "existing", "continuing")
COMPLEXITIES = ("low", "medium", "high")
MODELS = tuple(MODEL_SPECS)


def _case(rng: random.Random, index: int, situation: str, ood: bool = False) -> dict[str, Any]:
    hint = rng.choice(COMPLEXITIES)
    available = set(MODELS)
    target = rng.choice(TIER_MODELS[hint])
    case_kind = "ordinary"
    if ood:
        # OOD deliberately uses headroom ranges and availability patterns that
        # are absent from training: near-cap pools and a missing tier member.
        case_kind = rng.choice(("ood_headroom", "ood_unavailable", "ood_huge_context"))
        if case_kind == "ood_unavailable":
            available.discard(target)
        if case_kind == "ood_huge_context":
            context_tokens = rng.choice((170_000, 190_000, 210_000))
        else:
            context_tokens = rng.randrange(0, 130_000)
    else:
        edge = index % 17
        if edge == 0:
            case_kind = "exhausted_quota"
        elif edge == 1:
            case_kind = "needs_images"
        elif edge == 2:
            case_kind = "unavailable_models"
        elif edge == 3:
            case_kind = "huge_context"
        elif edge == 4:
            case_kind = "ambiguous"
        elif edge == 5:
            case_kind = "low_confidence"
        context_tokens = rng.randrange(0, 150_000)
        if case_kind == "huge_context":
            context_tokens = rng.choice((170_000, 190_000, 210_000))
        if case_kind == "unavailable_models":
            for model in rng.sample(list(available), rng.randrange(1, 4)):
                available.discard(model)
        available.add(target)

    stress = (not ood) and index % 10 < 4
    if stress:
        if index % 10 in {0, 1}:
            case_kind = "stress_huge_context"
            context_tokens = 500_000
        elif index % 10 == 2:
            case_kind = "stress_exhausted_quota"
        else:
            case_kind = "stress_restricted_availability"
            available = set(rng.sample(sorted(available), min(len(available), rng.choice((1, 2)))))
    needs_images = case_kind == "needs_images" or (case_kind == "ordinary" and rng.random() < 0.12)
    prev_model = "" if situation == "new" else rng.choice(MODELS)
    if situation == "existing":
        idle_gap = rng.uniform(30.0, 7 * 24 * 60.0)
    elif situation == "continuing":
        idle_gap = rng.uniform(0.0, 29.999)
    else:
        idle_gap = 0.0

    headroom = {"claude": rng.uniform(0.15, 1.0), "codex": rng.uniform(0.15, 1.0)}
    if case_kind in {"exhausted_quota", "stress_exhausted_quota", "stress_restricted_availability", "ood_headroom"}:
        exhausted = rng.choice(("claude", "codex"))
        headroom[exhausted] = rng.uniform(0.0, 0.1)
    if target in available and case_kind not in {"exhausted_quota", "stress_exhausted_quota", "stress_restricted_availability", "ood_headroom"}:
        headroom[MODEL_SPECS[target].provider] = max(headroom[MODEL_SPECS[target].provider], 0.2)
    # Every generated case has at least one possible concrete model. A large
    # context requires a codex candidate; a near-cap pool leaves the other pool.
    if case_kind in {"stress_exhausted_quota", "stress_restricted_availability"}:
        headroom["claude"] = 0.0
        headroom["codex"] = 0.0
    if context_tokens > 0.8 * 200_000:
        headroom["codex"] = max(headroom["codex"], 0.2)
        available.update(model for model in MODELS if MODEL_SPECS[model].provider == "codex")

    hard_cap = rng.choice((0.9, 0.9, 0.9, 0.85, 0.95))
    return {
        "scenario_id": f"{'ood' if ood else 'iid'}-{index:06d}",
        "situation": situation,
        "prev_model": prev_model,
        "idle_gap_minutes": round(idle_gap, 3),
        "complexity_hint": hint,
        "context_tokens": context_tokens,
        "needs_images": needs_images,
        "available": sorted(available),
        "headroom": {key: round(value, 6) for key, value in headroom.items()},
        "hard_cap": hard_cap,
        "case_kind": case_kind,
        "ood": ood,
    }


def generate_scenarios(total: int = 12_000, seed: int = 20261013, ood_total: int = 3_000) -> dict[str, list[dict[str, Any]]]:
    if total < 3 or total % 3:
        raise ValueError("total must be divisible by three")
    rng = random.Random(seed)
    cases = [_case(rng, index, SITUATIONS[index % 3]) for index in range(total)]
    rng.shuffle(cases)
    train_end = round(total * 0.70)
    validation_end = train_end + round(total * 0.15)
    for case in cases[:train_end]:
        case["split"] = "train"
    for case in cases[train_end:validation_end]:
        case["split"] = "validation"
    for case in cases[validation_end:]:
        case["split"] = "test"

    ood_rng = random.Random(seed + 1)
    ood = [_case(ood_rng, index, SITUATIONS[index % 3], ood=True) for index in range(ood_total)]
    for case in ood:
        case["split"] = "ood"
    return {
        "train": [case for case in cases if case["split"] == "train"],
        "validation": [case for case in cases if case["split"] == "validation"],
        "test": [case for case in cases if case["split"] == "test"],
        "ood": ood,
    }


def all_scenarios(groups: dict[str, list[dict[str, Any]]]) -> list[dict[str, Any]]:
    return [case for name in ("train", "validation", "test", "ood") for case in groups.get(name, [])]


def write_scenarios(groups: dict[str, list[dict[str, Any]]], output: Path) -> None:
    output.parent.mkdir(parents=True, exist_ok=True)
    with output.open("w", encoding="utf-8", newline="\n") as handle:
        for case in all_scenarios(groups):
            handle.write(json.dumps(case, sort_keys=True, separators=(",", ":")) + "\n")


def main() -> int:
    parser = argparse.ArgumentParser(description="Generate balanced policy scenarios")
    parser.add_argument("--output", type=Path, default=Path("data/scenarios.jsonl"))
    args = parser.parse_args()
    groups = generate_scenarios()
    write_scenarios(groups, args.output)
    print(json.dumps({name: len(items) for name, items in groups.items()}, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
