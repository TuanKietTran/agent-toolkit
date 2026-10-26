"""Default model-pick client: llama-swap when present, local otherwise."""

from __future__ import annotations

import json
import os
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any

from .guard import DecisionGuard, DecisionKindError
from .llama_swap import detect
from .policy import Decision, NoModelAvailable, pick_model
from .serve import DEFAULT_STUDENT
from .student import StudentPredictor, load_predictor

_fallback_count = 0
_local_student: StudentPredictor | None = None


def fallback_count() -> int:
    return _fallback_count


def _local_decide(scenario: dict[str, Any]) -> Decision:
    global _local_student
    if _local_student is None:
        path = Path(os.environ.get("SYSTEM_ONE_STUDENT", str(DEFAULT_STUDENT)))
        try:
            if path.is_file():
                _local_student = load_predictor(path)
        except Exception:
            _local_student = None
    if _local_student is not None:
        try:
            return _local_student.predict(scenario)
        except NoModelAvailable:
            raise
        except Exception:
            pass
    return pick_model(scenario)


# llama-swap only routes the OpenAI endpoints; custom paths reach a model through
# its passthrough prefix. A bare shim (no llama-swap) serves /v1/decide directly.
_DECIDE_PATHS = ("/upstream/system-one/v1/decide", "/v1/decide")


def _post_decide(base: str, path: str, body: bytes) -> dict[str, Any]:
    request = urllib.request.Request(
        f"{base.rstrip('/')}{path}",
        data=body,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(request, timeout=0.3) as response:
        if response.status != 200:
            raise OSError("backend status")
        return json.loads(response.read().decode("utf-8"))


def _remote_decide(base: str, scenario: dict[str, Any]) -> Decision:
    body = json.dumps(scenario, separators=(",", ":")).encode("utf-8")
    payload: Any = None
    for index, path in enumerate(_DECIDE_PATHS):
        try:
            payload = _post_decide(base, path, body)
            break
        except urllib.error.HTTPError as error:
            if error.code != 404 or index == len(_DECIDE_PATHS) - 1:
                raise
    if payload is None:
        raise OSError("no decide route")
    if not isinstance(payload, dict):
        raise ValueError("invalid decision payload")
    DecisionGuard().check(payload.get("kind", "model_pick"))
    model = payload["model"]
    if not isinstance(model, str) or not model:
        raise ValueError("invalid model")
    return Decision(
        model=model,
        rule=str(payload.get("rule", "REMOTE")),
        reason=str(payload.get("reason", "remote decision")),
        degraded_level=int(payload.get("degraded_level", 0)),
        kind="model_pick",
    )


def decide(scenario: dict[str, Any]) -> Decision:
    """Use llama-swap when advertised, silently falling back to local policy."""
    global _fallback_count
    if os.environ.get("SYSTEM_ONE_BACKEND", "auto").lower() == "local":
        return _local_decide(scenario)
    base = detect(timeout=0.3)
    if base:
        try:
            return _remote_decide(base, scenario)
        except NoModelAvailable:
            # A remote empty catalog is not a transport failure; local policy
            # remains the authoritative autonomous fallback.
            pass
        except (OSError, ValueError, KeyError, TypeError, json.JSONDecodeError, DecisionKindError):
            pass
        _fallback_count += 1
    return _local_decide(scenario)


__all__ = ["decide", "fallback_count"]
