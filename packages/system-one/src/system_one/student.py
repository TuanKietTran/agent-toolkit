"""Tiny policy-distilled student with JSON-only runtime inference."""

from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from .guard import DecisionGuard
from .policy import MODEL_SPECS, Decision, Scenario, TIER_MODELS, is_usable, model_degraded_level, pick_model

FEATURE_NAMES = (
    "situation_new",
    "situation_existing",
    "situation_continuing",
    "complexity_low",
    "complexity_medium",
    "complexity_high",
    "needs_images",
    "context_ratio",
    "idle_gap_ratio",
    "headroom_claude",
    "headroom_codex",
    "hard_cap",
    "prev_empty",
    *(f"prev_{model}" for model in MODEL_SPECS),
    *(f"available_{model}" for model in MODEL_SPECS),
)


def _scenario(value: Scenario | dict[str, Any]) -> Scenario:
    return value if isinstance(value, Scenario) else Scenario.from_mapping(value if isinstance(value, dict) else {})


def feature_vector(value: Scenario | dict[str, Any]) -> list[float]:
    scenario = _scenario(value)
    vector: list[float] = []
    vector.extend(float(scenario.situation == item) for item in ("new", "existing", "continuing"))
    vector.extend(float(scenario.complexity_hint == item) for item in ("low", "medium", "high"))
    vector.append(float(scenario.needs_images))
    vector.append(scenario.context_tokens / 272_000.0)
    vector.append(min(scenario.idle_gap_minutes, 10080.0) / 10080.0)
    vector.append(float(scenario.headroom.get("claude", 0.0)))
    vector.append(float(scenario.headroom.get("codex", 0.0)))
    vector.append(float(scenario.hard_cap))
    vector.append(float(not scenario.prev_model))
    vector.extend(float(scenario.prev_model == model) for model in MODEL_SPECS)
    vector.extend(float(model in scenario.available) for model in MODEL_SPECS)
    return vector


@dataclass(frozen=True)
class JsonTreeModel:
    feature_names: tuple[str, ...]
    classes: tuple[str, ...]
    children_left: tuple[int, ...]
    children_right: tuple[int, ...]
    features: tuple[int, ...]
    thresholds: tuple[float, ...]
    values: tuple[tuple[tuple[float, ...], ...], ...]

    @classmethod
    def from_json(cls, path: Path) -> "JsonTreeModel":
        payload = json.loads(path.read_text(encoding="utf-8"))
        return cls(
            tuple(payload["feature_names"]),
            tuple(payload["classes"]),
            tuple(payload["children_left"]),
            tuple(payload["children_right"]),
            tuple(payload["features"]),
            tuple(payload["thresholds"]),
            tuple(tuple(tuple(float(item) for item in row) for row in node) for node in payload["values"]),
        )

    def _predict_raw(self, value: Scenario | dict[str, Any]) -> str:
        features = feature_vector(value)
        node = 0
        while self.children_left[node] != self.children_right[node]:
            feature = self.features[node]
            node = self.children_left[node] if features[feature] <= self.thresholds[node] else self.children_right[node]
        counts = self.values[node][0]
        label = self.classes[max(range(len(counts)), key=counts.__getitem__)]
        return label


class StudentPredictor:
    """Propose with a JSON tree; validators can replace the proposal with policy."""

    def __init__(self, model: JsonTreeModel) -> None:
        self.model = model
        self.fallback_count = 0
        self.total_count = 0

    def _valid(self, scenario: Scenario, proposed: str) -> bool:
        if proposed not in MODEL_SPECS or proposed not in scenario.available:
            return False
        strict = [model for model in scenario.available if is_usable(scenario, model)]
        if strict:
            if proposed not in strict:
                return False
            if scenario.situation in {"existing", "continuing"} and is_usable(scenario, scenario.prev_model):
                return proposed == scenario.prev_model
            tier_models = [model for model in TIER_MODELS[scenario.complexity_hint] if is_usable(scenario, model)]
            return scenario.situation != "new" or proposed in tier_models
        # Once strict candidates are exhausted, hold-before-switch still wins
        # at the first relaxation level selected by the explicit policy.
        policy_decision = pick_model(scenario)
        if scenario.situation in {"existing", "continuing"} and policy_decision.rule in {"R1", "R2"}:
            return proposed == policy_decision.model
        return model_degraded_level(scenario, proposed) >= 0

    def predict(self, value: Scenario | dict[str, Any]) -> Decision:
        DecisionGuard().check("model_pick")
        scenario = _scenario(value)
        self.total_count += 1
        proposed = self.model._predict_raw(scenario)
        if self._valid(scenario, proposed):
            level = model_degraded_level(scenario, proposed)
            return Decision(proposed, "STUDENT", f"validated student proposal; level {level}", level)
        self.fallback_count += 1
        fallback = pick_model(scenario)
        return Decision(fallback.model, fallback.rule, f"validator fallback: {fallback.reason}")


def train_student(cases: list[dict[str, Any]], output: Path, max_depth: int = 18) -> dict[str, Any]:
    """Train only from policy labels and export a JSON decision tree."""
    try:
        from sklearn.tree import DecisionTreeClassifier
    except ImportError as error:  # pragma: no cover - environment setup failure
        raise RuntimeError("scikit-learn is required only for training") from error

    x = [feature_vector(case) for case in cases]
    labels = [pick_model(case).model for case in cases]
    classifier = DecisionTreeClassifier(max_depth=max_depth, min_samples_leaf=2, random_state=20261013)
    classifier.fit(x, labels)
    tree = classifier.tree_
    payload = {
        "format": "system-one-policy-tree-v1",
        "feature_names": list(FEATURE_NAMES),
        "classes": [str(item) for item in classifier.classes_],
        "children_left": tree.children_left.tolist(),
        "children_right": tree.children_right.tolist(),
        "features": tree.feature.tolist(),
        "thresholds": tree.threshold.tolist(),
        "values": tree.value.tolist(),
        "training_rows": len(cases),
        "max_depth": max_depth,
    }
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(payload, sort_keys=True, indent=2) + "\n", encoding="utf-8")
    return payload


def load_predictor(path: Path) -> StudentPredictor:
    return StudentPredictor(JsonTreeModel.from_json(path))


__all__ = ["FEATURE_NAMES", "JsonTreeModel", "StudentPredictor", "load_predictor", "train_student"]
