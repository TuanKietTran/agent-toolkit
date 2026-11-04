"""Autonomous, metadata-only model-pick policy.

This is an explicit policy, not a learned model of owner behaviour. Every
successful decision is a concrete usable catalog model; impossible catalogs
raise NoModelAvailable.
"""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass
import math
from typing import Any, Literal

from .guard import DecisionGuard

Situation = Literal["new", "existing", "continuing"]
Complexity = Literal["low", "medium", "high"]
Tier = Literal["low", "medium", "high"]
HARD_CAP_DEFAULT = 0.9
CONTEXT_FIT_FRACTION = 0.8

CODEX_COSTS: dict[str, dict[str, float]] = {
    "gpt-6-luna": {"input": 0.1, "output": 0.5, "cacheRead": 0.01},
    "gpt-5.6-luna": {"input": 0.2, "output": 1.2, "cacheRead": 0.02},
    "gpt-6-sol": {"input": 2.0, "output": 10.0, "cacheRead": 0.2},
    "gpt-6.1-sol": {"input": 2.0, "output": 10.0, "cacheRead": 0.1},
    "gpt-5.6-sol": {"input": 4.0, "output": 20.0, "cacheRead": 0.4},
    "gpt-5.5": {"input": 5.0, "output": 30.0, "cacheRead": 0.5},
    "gpt-6-astra": {"input": 10.0, "output": 50.0, "cacheRead": 1.0},
}


def _blend(cost: Mapping[str, float]) -> float:
    return cost["input"] * 0.25 + cost["cacheRead"] * 0.6 + cost["output"] * 0.15


@dataclass(frozen=True)
class ModelSpec:
    model: str
    provider: Literal["claude", "codex"]
    tier: Tier
    context_window: int
    price_index: float
    generation: int
    legacy: bool = False
    supports_images: bool = True


MODEL_SPECS: dict[str, ModelSpec] = {
    "claude-haiku-5-5": ModelSpec("claude-haiku-5-5", "claude", "low", 200_000, 1.0, 55),
    "claude-sonnet-5-5": ModelSpec("claude-sonnet-5-5", "claude", "medium", 200_000, 3.0, 55),
    "claude-sonnet-5": ModelSpec("claude-sonnet-5", "claude", "medium", 200_000, 3.0, 5, True),
    "claude-opus-5": ModelSpec("claude-opus-5", "claude", "high", 200_000, 5.0, 5),
    "gpt-6-luna": ModelSpec("gpt-6-luna", "codex", "low", 272_000, _blend(CODEX_COSTS["gpt-6-luna"]), 6),
    "gpt-5.6-luna": ModelSpec("gpt-5.6-luna", "codex", "low", 272_000, _blend(CODEX_COSTS["gpt-5.6-luna"]), 56),
    "gpt-6-sol": ModelSpec("gpt-6-sol", "codex", "medium", 272_000, _blend(CODEX_COSTS["gpt-6-sol"]), 6),
    "gpt-6.1-sol": ModelSpec("gpt-6.1-sol", "codex", "medium", 272_000, _blend(CODEX_COSTS["gpt-6.1-sol"]), 61),
    "gpt-5.6-sol": ModelSpec("gpt-5.6-sol", "codex", "high", 272_000, _blend(CODEX_COSTS["gpt-5.6-sol"]), 56),
    "gpt-5.5": ModelSpec("gpt-5.5", "codex", "high", 272_000, _blend(CODEX_COSTS["gpt-5.5"]), 55),
    "gpt-6-astra": ModelSpec("gpt-6-astra", "codex", "high", 272_000, _blend(CODEX_COSTS["gpt-6-astra"]), 6),
}

TIER_ORDER = {"low": 0, "medium": 1, "high": 2}
TIER_MODELS = {
    tier: tuple(model for model, spec in MODEL_SPECS.items() if spec.tier == tier)
    for tier in ("low", "medium", "high")
}
RELAXATION_REASONS = (
    "strict constraints",
    "quota margin relaxed",
    "quota ignored",
    "context limit relaxed to window",
    "context fit ignored",
    "image requirement relaxed",
)


class NoModelAvailable(RuntimeError):
    """Raised only when no catalog model appears in the supplied availability."""


@dataclass(frozen=True)
class Scenario:
    situation: Situation
    prev_model: str
    idle_gap_minutes: float
    complexity_hint: Complexity
    context_tokens: int
    needs_images: bool
    available: frozenset[str]
    headroom: Mapping[str, float]
    hard_cap: float = HARD_CAP_DEFAULT

    @classmethod
    def from_mapping(cls, value: Mapping[str, Any]) -> "Scenario":
        raw_prev = value.get("prev_model", "")
        prev = raw_prev if isinstance(raw_prev, str) else ""
        raw_situation = value.get("situation", "")
        situation = raw_situation if raw_situation in {"new", "existing", "continuing"} else (
            "continuing" if prev else "new"
        )
        raw_hint = value.get("complexity_hint", "medium")
        hint = raw_hint if raw_hint in {"low", "medium", "high"} else "medium"
        raw_available = value["available"] if "available" in value and value["available"] is not None else MODEL_SPECS
        try:
            available = frozenset(item for item in raw_available if isinstance(item, str))
        except TypeError:
            available = frozenset(MODEL_SPECS)
        if "available" not in value or value.get("available") is None:
            available = frozenset(MODEL_SPECS)
        return cls(
            situation=situation,
            prev_model=prev,
            idle_gap_minutes=_nonnegative(value.get("idle_gap_minutes", 0.0)),
            complexity_hint=hint,
            context_tokens=int(_nonnegative(value.get("context_tokens", 0.0))),
            needs_images=bool(value.get("needs_images", False)),
            available=available,
            headroom={"claude": _headroom(value.get("headroom"), "claude"),
                      "codex": _headroom(value.get("headroom"), "codex")},
            hard_cap=_bounded(value.get("hard_cap", HARD_CAP_DEFAULT)),
        )


def _nonnegative(value: Any) -> float:
    try:
        result = float(value)
    except (TypeError, ValueError, OverflowError):
        return 0.0
    return result if math.isfinite(result) and result >= 0.0 else 0.0


def _headroom(value: Any, provider: str) -> float:
    if not isinstance(value, Mapping) or provider not in value or value[provider] is None:
        return 1.0
    raw = value[provider]
    if isinstance(raw, bool) or not isinstance(raw, (int, float)):
        return 1.0
    return _bounded(raw)


def _bounded(value: Any) -> float:
    try:
        result = float(value)
    except (TypeError, ValueError, OverflowError):
        return 0.0
    return min(1.0, max(0.0, result)) if math.isfinite(result) else 0.0


@dataclass(frozen=True)
class Decision:
    model: str
    rule: str
    reason: str
    degraded_level: int = 0
    kind: str = "model_pick"

    def __post_init__(self) -> None:
        DecisionGuard().check(self.kind)


def _coerce_scenario(value: Scenario | Mapping[str, Any] | Any) -> Scenario:
    if isinstance(value, Scenario):
        return Scenario.from_mapping({
            "situation": value.situation,
            "prev_model": value.prev_model,
            "idle_gap_minutes": value.idle_gap_minutes,
            "complexity_hint": value.complexity_hint,
            "context_tokens": value.context_tokens,
            "needs_images": value.needs_images,
            "available": value.available,
            "headroom": value.headroom,
            "hard_cap": value.hard_cap,
        })
    if isinstance(value, Mapping):
        return Scenario.from_mapping(value)
    return Scenario.from_mapping({})


def _catalog_available(scenario: Scenario) -> list[str]:
    return [model for model in MODEL_SPECS if model in scenario.available]


def _strict_usable(scenario: Scenario, model: str) -> bool:
    if model not in _catalog_available(scenario):
        return False
    spec = MODEL_SPECS[model]
    margin = max(0.0, 1.0 - scenario.hard_cap)
    return (
        scenario.context_tokens <= CONTEXT_FIT_FRACTION * spec.context_window
        and (not scenario.needs_images or spec.supports_images)
        and scenario.headroom.get(spec.provider, 0.0) > margin
    )


def is_usable(scenario: Scenario | Mapping[str, Any], model: str) -> bool:
    """Strict level-zero usability check."""
    return _strict_usable(_coerce_scenario(scenario), model)


def _candidates(scenario: Scenario, level: int) -> list[str]:
    result: list[str] = []
    margin = max(0.0, 1.0 - scenario.hard_cap)
    for model in _catalog_available(scenario):
        spec = MODEL_SPECS[model]
        if level <= 2 and scenario.context_tokens > CONTEXT_FIT_FRACTION * spec.context_window:
            continue
        if level == 3 and scenario.context_tokens > spec.context_window:
            continue
        if level <= 4 and scenario.needs_images and not spec.supports_images:
            continue
        headroom = scenario.headroom.get(spec.provider, 0.0)
        if level == 0 and headroom <= margin:
            continue
        if level == 1 and headroom <= 0.0:
            continue
        result.append(model)
    return result


def _ranked(scenario: Scenario, models: list[str], level: int) -> list[str]:
    hint = TIER_ORDER[scenario.complexity_hint]
    tiered = [model for model in models if TIER_ORDER[MODEL_SPECS[model].tier] == hint]
    pool = tiered or models
    modern = [model for model in pool if not MODEL_SPECS[model].legacy]
    pool = modern or pool
    if level <= 1:
        return sorted(pool, key=lambda model: (-scenario.headroom[MODEL_SPECS[model].provider], MODEL_SPECS[model].price_index, model))
    return sorted(pool, key=lambda model: (MODEL_SPECS[model].price_index, model))


def _decision_for(scenario: Scenario, model: str, rule: str, level: int) -> Decision:
    reason = RELAXATION_REASONS[level]
    if level:
        reason = f"{reason}; deterministic fallback"
    return Decision(model, rule, reason, level)


def pick_model(scenario: Scenario | Mapping[str, Any] | Any) -> Decision:
    """Always return a concrete model or raise only for an empty catalog choice."""
    DecisionGuard().check("model_pick")
    current = _coerce_scenario(scenario)
    if not _catalog_available(current):
        raise NoModelAvailable("available set contains no catalog model")

    for level in range(len(RELAXATION_REASONS)):
        candidates = _candidates(current, level)
        if not candidates:
            continue
        if current.situation in {"continuing", "existing"} and current.prev_model in candidates:
            rule = "R1" if current.situation == "continuing" else "R2"
            return _decision_for(current, current.prev_model, rule, level)
        chosen = _ranked(current, candidates, level)[0]
        return _decision_for(current, chosen, "R3", level)
    raise NoModelAvailable("catalog models are unavailable after relaxation ladder")


def model_degraded_level(scenario: Scenario | Mapping[str, Any], model: str) -> int:
    current = _coerce_scenario(scenario)
    for level in range(len(RELAXATION_REASONS)):
        if model in _candidates(current, level):
            return level
    return len(RELAXATION_REASONS) - 1


__all__ = [
    "CODEX_COSTS", "Decision", "HARD_CAP_DEFAULT", "MODEL_SPECS", "NoModelAvailable",
    "RELAXATION_REASONS", "Scenario", "TIER_MODELS", "is_usable", "model_degraded_level", "pick_model",
]
