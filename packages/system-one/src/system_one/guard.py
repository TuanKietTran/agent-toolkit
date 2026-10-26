"""Safety boundary for decisions and event ingestion.

system-one is intentionally not a permission-decision component.  The public
allowlist contains only model selection, and configuration can only select a
subset of that compiled allowlist.
"""

from __future__ import annotations

import re
from collections.abc import Iterable, Mapping
from typing import Any

DEFAULT_ALLOWED_DECISION_KINDS = frozenset({"model_pick"})
FORBIDDEN_KIND_TERMS = (
    "permission",
    "approval",
    "consent",
    "allow",
    "deny",
    "grant",
    "confirm",
)


def normalize_kind(kind: str) -> str:
    if not isinstance(kind, str) or not kind.strip():
        raise DecisionKindError("decision kind must be a non-empty string")
    return re.sub(r"[^a-z0-9]+", "_", kind.strip().lower()).strip("_")


def _forbidden(kind: str) -> bool:
    normalized = normalize_kind(kind)
    return any(term in normalized for term in FORBIDDEN_KIND_TERMS)


class DecisionKindError(ValueError):
    """Raised when a decision kind is outside the compiled safe allowlist."""


class DecisionGuard:
    """Default-deny decision guard with a non-expandable config boundary."""

    def __init__(self, allowed_kinds: Iterable[str] | None = None) -> None:
        requested = DEFAULT_ALLOWED_DECISION_KINDS if allowed_kinds is None else frozenset(allowed_kinds)
        normalized = frozenset(normalize_kind(kind) for kind in requested)
        forbidden = sorted(kind for kind in normalized if _forbidden(kind))
        unknown = sorted(normalized - DEFAULT_ALLOWED_DECISION_KINDS)
        if forbidden:
            raise DecisionKindError(f"forbidden decision kind(s): {', '.join(forbidden)}")
        if unknown:
            raise DecisionKindError(f"unsupported decision kind(s): {', '.join(unknown)}")
        self._allowed = normalized

    @classmethod
    def from_config(cls, config: Mapping[str, Any] | None) -> "DecisionGuard":
        if not config or "decision_kinds" not in config:
            return cls()
        kinds = config["decision_kinds"]
        if isinstance(kinds, (str, bytes)):
            raise DecisionKindError("decision_kinds must be a list")
        return cls(kinds)

    @property
    def allowed_kinds(self) -> frozenset[str]:
        return self._allowed

    def check(self, kind: str) -> str:
        normalized = normalize_kind(kind)
        if normalized not in self._allowed:
            raise DecisionKindError(f"decision kind is not allowed: {normalized}")
        return normalized

    def allows(self, kind: str) -> bool:
        try:
            return self.check(kind) == normalize_kind(kind)
        except DecisionKindError:
            return False
