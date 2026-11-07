"""CLI bridge: read one model_pick scenario on stdin, print one decision line.

Usage: ``python -m system_one.pick`` with a single JSON scenario object on
stdin. Exit codes: 0 = decision printed, 3 = no catalog model available,
4 = decision kind other than ``model_pick`` refused by the guard,
2 = unreadable input. Standard library only; backend/student selection is
honoured through ``system_one.client.decide`` (``SYSTEM_ONE_BACKEND`` /
``SYSTEM_ONE_STUDENT``).
"""

from __future__ import annotations

import json
import sys
from typing import Any

from .client import decide
from .guard import DecisionGuard, DecisionKindError
from .policy import NoModelAvailable


def _emit(payload: dict[str, Any]) -> None:
    sys.stdout.write(json.dumps(payload) + "\n")
    sys.stdout.flush()


def main() -> int:
    raw = sys.stdin.read()
    try:
        scenario = json.loads(raw)
    except (ValueError, TypeError):
        _emit({"error": "invalid_input"})
        return 2
    if not isinstance(scenario, dict):
        _emit({"error": "invalid_input"})
        return 2
    kind = scenario.get("kind", "model_pick")
    try:
        DecisionGuard().check(kind if isinstance(kind, str) else "")
    except DecisionKindError:
        _emit({"error": "decision_kind_refused"})
        return 4
    try:
        decision = decide(scenario)
    except NoModelAvailable:
        _emit({"error": "no_model_available"})
        return 3
    except DecisionKindError:
        _emit({"error": "decision_kind_refused"})
        return 4
    _emit({
        "model": decision.model,
        "rule": decision.rule,
        "reason": decision.reason,
        "degraded_level": decision.degraded_level,
        "kind": decision.kind,
    })
    return 0


if __name__ == "__main__":
    sys.exit(main())
