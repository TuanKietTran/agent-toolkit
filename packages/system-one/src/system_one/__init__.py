"""Metadata-only inventory and decision-kind safety for system-one."""

from .guard import DecisionGuard, DecisionKindError

__all__ = ["DecisionGuard", "DecisionKindError"]
