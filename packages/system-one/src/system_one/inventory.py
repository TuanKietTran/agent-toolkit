"""Build a metadata-only model-pick dataset from local JSONL sessions.

This module never writes message text, prompts, tool arguments/results, or file
contents. It only counts structural metadata and lengths while parsing.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
from collections import Counter, defaultdict
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterator

from .guard import FORBIDDEN_KIND_TERMS

SESSION_GAP_SECONDS = 30 * 60
JUNK_MODELS = frozenset({"<synthetic>", "b"})
_FORBIDDEN_RE = re.compile("|".join(re.escape(term) for term in FORBIDDEN_KIND_TERMS))


def _norm_key(key: Any) -> str:
    return re.sub(r"[^a-z0-9]+", "", str(key).lower())


def _forbidden_text(value: Any) -> bool:
    return isinstance(value, str) and bool(_FORBIDDEN_RE.search(_norm_key(value)))


def is_permission_event(record: MappingLike) -> bool:
    """Return true using structural fields only; never inspect message text."""
    if not isinstance(record, dict):
        return False
    record_type = record.get("type")
    if _forbidden_text(record_type) and "permission" in _norm_key(record_type):
        return True

    def walk(value: Any, root: bool = False) -> bool:
        if isinstance(value, dict):
            for key, child in value.items():
                key_norm = _norm_key(key)
                if _FORBIDDEN_RE.search(key_norm):
                    return True
                # Only structural discriminator values are examined. Arbitrary
                # strings can be message text and are deliberately ignored.
                if key_norm in {"type", "kind", "eventtype", "eventkind"} and _forbidden_text(child):
                    return True
                if isinstance(child, (dict, list)) and walk(child):
                    return True
        elif isinstance(value, list):
            return any(walk(child) for child in value if isinstance(child, (dict, list)))
        return False

    return walk(record, True)


# A narrow alias keeps the public function annotation readable without pulling
# in typing machinery at runtime.
MappingLike = dict[str, Any]


def permission_drop_reason(record: MappingLike) -> str | None:
    if not is_permission_event(record):
        return None
    record_type = _norm_key(record.get("type", ""))
    if "permission" in record_type:
        return "permission_event_type"
    return "permission_mode_field"


def _hash_session(source: str, session_key: str) -> str:
    return hashlib.sha256(f"{source}:{session_key}".encode("utf-8")).hexdigest()[:16]


def _split_for(session_hash: str) -> str:
    bucket = int(session_hash[:8], 16) % 10
    return "train" if bucket < 8 else "validation" if bucket == 8 else "test"


def _timestamp(value: Any) -> float | None:
    if not isinstance(value, str) or not value:
        return None
    try:
        text = value.replace("Z", "+00:00")
        parsed = datetime.fromisoformat(text)
        if parsed.tzinfo is None:
            parsed = parsed.replace(tzinfo=timezone.utc)
        return parsed.timestamp()
    except (TypeError, ValueError, OverflowError):
        return None


def _timestamp_output(value: Any) -> str | None:
    return value if isinstance(value, str) and value else None


def _session_key(source: str, path: Path, record: dict[str, Any]) -> str:
    if source == "claude":
        value = record.get("sessionId") or record.get("session_id")
        return str(value) if value else path.stem
    name = path.stem
    return name.split("_", 1)[1] if "_" in name else name


def _nested_content_stats(content: Any) -> dict[str, Any]:
    stats: dict[str, Any] = {
        "text_length": 0,
        "tool_use_count": 0,
        "tool_result_count": 0,
        "image_present": False,
        "tool_names": [],
    }

    def visit(value: Any) -> None:
        if isinstance(value, str):
            stats["text_length"] += len(value)
            return
        if isinstance(value, list):
            for child in value:
                visit(child)
            return
        if not isinstance(value, dict):
            return
        block_type = value.get("type")
        if block_type in {"tool_use", "toolCall"}:
            stats["tool_use_count"] += 1
            name = value.get("name")
            if isinstance(name, str) and name:
                stats["tool_names"].append(name)
        elif block_type in {"tool_result", "toolResult"}:
            stats["tool_result_count"] += 1
        elif block_type == "image":
            stats["image_present"] = True
        # Count visible text lengths only; do not retain the string.
        if block_type in {"text", "thinking"} and isinstance(value.get("text"), str):
            stats["text_length"] += len(value["text"])
        for key, child in value.items():
            if key in {"text", "thinking"}:
                continue
            if isinstance(child, (dict, list)):
                visit(child)

    visit(content)
    return stats


def _record_stats(source: str, record: dict[str, Any]) -> tuple[dict[str, Any], dict[str, Any]] | None:
    if source == "claude":
        if record.get("type") not in {"user", "assistant"}:
            return None
        message = record.get("message")
        if not isinstance(message, dict):
            return None
        role = "assistant" if record.get("type") == "assistant" else "user"
        content = message.get("content")
        usage = message.get("usage") if isinstance(message.get("usage"), dict) else {}
        model = message.get("model")
        stats = _nested_content_stats(content)
        if isinstance(content, str):
            stats["text_length"] = len(content)
        return (
            {
                "role": role,
                "model": model if isinstance(model, str) and model else None,
                "context_size_tokens": usage.get("input_tokens") or record.get("contextLength"),
                "tokens_in": usage.get("input_tokens", 0) or 0,
                "tokens_out": usage.get("output_tokens", 0) or 0,
                "tokens_cache_read": usage.get("cache_read_input_tokens", 0) or 0,
                "tokens_cache_write": usage.get("cache_creation_input_tokens", 0) or 0,
                "tool_result_role": False,
                "sidechain": bool(record.get("isSidechain", False)),
            },
            stats,
        )

    if record.get("type") != "message":
        return None
    message = record.get("message")
    if not isinstance(message, dict):
        return None
    raw_role = message.get("role")
    role = "tool" if raw_role == "toolResult" else raw_role
    if role not in {"user", "assistant", "tool"}:
        return None
    usage = message.get("usage") if isinstance(message.get("usage"), dict) else {}
    content = message.get("content")
    stats = _nested_content_stats(content)
    if isinstance(content, str):
        stats["text_length"] = len(content)
    return (
        {
            "role": role,
            "model": message.get("model") if isinstance(message.get("model"), str) else None,
            "context_size_tokens": usage.get("input") or record.get("contextLength"),
            "tokens_in": usage.get("input", 0) or 0,
            "tokens_out": usage.get("output", 0) or 0,
            "tokens_cache_read": usage.get("cacheRead", 0) or 0,
            "tokens_cache_write": usage.get("cacheWrite", 0) or 0,
            "tool_result_role": role == "tool",
            "sidechain": bool(record.get("isSidechain", False)),
        },
        stats,
    )


def _explicit_resume(record: dict[str, Any]) -> bool:
    # Inspect names and small structural discriminator values only. Never
    # search arbitrary strings, because those may be message text.
    keys = {_norm_key(key) for key in record}
    if keys & {"resume", "resumesession", "sessionresume", "isresume", "resumed"}:
        return True
    for key in ("type", "subtype", "eventType", "event_type", "promptSource", "prompt_source"):
        value = record.get(key)
        if isinstance(value, str) and _norm_key(value) in {"resume", "sessionresume", "resumed"}:
            return True
    return False


def _has_image(record: dict[str, Any], stats: dict[str, Any]) -> bool:
    if stats["image_present"]:
        return True
    ids = record.get("imagePasteIds")
    return isinstance(ids, list) and bool(ids)


def _is_sidechain(record: dict[str, Any]) -> bool:
    return record.get("isSidechain") is True


def iter_records(
    roots: dict[str, Path], exclude_paths: set[Path] | None = None
) -> Iterator[tuple[str, Path, int, dict[str, Any]]]:
    excluded = {path.resolve() for path in (exclude_paths or set())}
    for source, root in roots.items():
        if not root.exists():
            continue
        for path in sorted(root.rglob("*.jsonl")):
            if path.resolve() in excluded:
                continue
            with path.open("r", encoding="utf-8", errors="replace") as handle:
                for line_number, line in enumerate(handle, 1):
                    try:
                        record = json.loads(line)
                    except json.JSONDecodeError:
                        continue
                    if isinstance(record, dict):
                        yield source, path, line_number, record


def build_inventory(
    claude_root: Path, pi_root: Path, exclude_session_file: Path | None = None
) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    roots = {"claude": claude_root, "pi": pi_root}
    exclude_paths = {exclude_session_file} if exclude_session_file is not None else set()
    rows: list[dict[str, Any]] = []
    summary: dict[str, Any] = {
        "sources": {},
        "permission_drops": Counter(),
        "invalid_json_lines": 0,
        "records_scanned": 0,
        "candidate_assistant_events": 0,
        "assistant_events_without_model": 0,
        "junk_model_events": 0,
        "decision_points": 0,
        "sidechain_candidate_assistant_events": 0,
        "explicit_resume_decision_points": 0,
        "resume_gap_events": 0,
        "sessions": set(),
        "model_change_events": 0,
    }
    session_state: dict[str, dict[str, Any]] = {}
    seen_files: Counter[str] = Counter()

    # Parse in path/line order. Every non-sidechain record with a timestamp is
    # part of the main-thread clock, even when it is not a conversation record.
    # A long gap is carried from the resumed user record to its next model run.
    for source, path, line_number, record in iter_records(roots, exclude_paths):
        summary["records_scanned"] += 1
        seen_files[source] += 1 if line_number == 1 else 0
        drop_reason = permission_drop_reason(record)
        if drop_reason:
            summary["permission_drops"][drop_reason] += 1
            continue
        if _is_sidechain(record):
            if record.get("type") == "assistant":
                summary["sidechain_candidate_assistant_events"] += 1
            continue
        if record.get("type") == "model_change":
            summary["model_change_events"] += 1
        key = _session_key(source, path, record)
        session_hash = _hash_session(source, key)
        state = session_state.setdefault(
            session_hash,
            {
                "source": source,
                "seen_model_run": False,
                "turn_index": 0,
                "turn_tool_uses": 0,
                "turn_tool_results": 0,
                "turn_text_length": 0,
                "turn_image": False,
                "last_main_timestamp": None,
                "pending_resume_gap_minutes": None,
                "current_model": None,
                "turn_tool_names": [],
            },
        )
        summary["sessions"].add(session_hash)

        # Model changes are metadata and are used only as a fallback for old
        # pi messages that lack a model field.
        if source == "pi" and record.get("type") == "model_change":
            model_id = record.get("modelId")
            if isinstance(model_id, str) and model_id:
                state["current_model"] = model_id
        timestamp = record.get("timestamp")
        current_timestamp = _timestamp(timestamp)
        immediate_gap = None
        if current_timestamp is not None and state["last_main_timestamp"] is not None:
            delta = current_timestamp - state["last_main_timestamp"]
            immediate_gap = max(0.0, delta) / 60.0
            if delta >= SESSION_GAP_SECONDS:
                state["pending_resume_gap_minutes"] = delta / 60.0
                summary["resume_gap_events"] += 1
        if current_timestamp is not None:
            state["last_main_timestamp"] = current_timestamp

        parsed = _record_stats(source, record)
        if parsed is None:
            continue
        meta, stats = parsed
        if meta["role"] == "assistant":
            summary["candidate_assistant_events"] += 1
            model = meta["model"] or state["current_model"]
            if not model:
                summary["assistant_events_without_model"] += 1
                continue
            if model in JUNK_MODELS:
                summary["junk_model_events"] += 1
                continue
            if state["turn_index"] == 0:
                state["turn_index"] = 1
            state["turn_tool_uses"] += stats["tool_use_count"]
            state["turn_tool_results"] += stats["tool_result_count"]
            state["turn_text_length"] += stats["text_length"]
            state["turn_image"] = state["turn_image"] or _has_image(record, stats)
            explicit_resume = _explicit_resume(record)
            resumed = explicit_resume or state["pending_resume_gap_minutes"] is not None or (
                immediate_gap is not None and immediate_gap >= 30.0
            )
            situation = "existing" if resumed else ("new" if not state["seen_model_run"] else "continuing")
            decision_gap = state["pending_resume_gap_minutes"]
            if decision_gap is None:
                decision_gap = immediate_gap
            state["seen_model_run"] = True
            state["pending_resume_gap_minutes"] = None
            split = _split_for(session_hash)
            row = {
                "source": source,
                "session_id_hash": session_hash,
                "split": split,
                "timestamp": _timestamp_output(timestamp),
                "event_type": "model_run",
                "role": "assistant",
                "model": model,
                "situation": situation,
                "turn_index": state["turn_index"],
                "idle_gap_minutes": round(decision_gap, 3) if decision_gap is not None else None,
                "explicit_resume": explicit_resume,
                "context_size_tokens": meta["context_size_tokens"],
                "tokens_in": meta["tokens_in"],
                "tokens_out": meta["tokens_out"],
                "tokens_cache_read": meta["tokens_cache_read"],
                "tokens_cache_write": meta["tokens_cache_write"],
                "tool_use_count": state["turn_tool_uses"],
                "tool_result_count": state["turn_tool_results"],
                "tool_names": sorted(set(state["turn_tool_names"] + stats["tool_names"])),
                "image_present": state["turn_image"],
                "text_length": stats["text_length"],
                "turn_text_length": state["turn_text_length"],
                "sidechain": False,
            }
            rows.append(row)
            summary["decision_points"] += 1
            summary["explicit_resume_decision_points"] += int(explicit_resume)
        elif meta["role"] == "user" and not meta["tool_result_role"]:
            state["turn_index"] += 1
            state["turn_tool_uses"] = 0
            state["turn_tool_results"] = 0
            state["turn_text_length"] = stats["text_length"]
            state["turn_image"] = _has_image(record, stats)
            state["turn_tool_names"] = list(stats["tool_names"])
        elif meta["role"] == "tool":
            state["turn_tool_results"] += 1
            state["turn_image"] = state["turn_image"] or _has_image(record, stats)
        else:
            state["turn_tool_uses"] += stats["tool_use_count"]
            state["turn_tool_results"] += stats["tool_result_count"]
            state["turn_tool_names"] = state["turn_tool_names"] + stats["tool_names"]
            state["turn_image"] = state["turn_image"] or _has_image(record, stats)

    by_source = Counter(row["source"] for row in rows)
    by_situation = Counter(row["situation"] for row in rows)
    by_model = Counter(row["model"] for row in rows)
    by_split = Counter(row["split"] for row in rows)
    by_split_situation = Counter((row["split"], row["situation"]) for row in rows)
    by_situation_model = Counter((row["situation"], row["model"]) for row in rows)
    by_source_situation = Counter((row["source"], row["situation"]) for row in rows)
    idle_gaps = [row["idle_gap_minutes"] for row in rows if row["idle_gap_minutes"] is not None]
    summary_out: dict[str, Any] = {
        "sources": {source: {"files": seen_files[source]} for source in roots},
        "records_scanned": summary["records_scanned"],
        "sessions": len(summary["sessions"]),
        "candidate_assistant_events": summary["candidate_assistant_events"],
        "assistant_events_without_model": summary["assistant_events_without_model"],
        "decision_points": summary["decision_points"],
        "permission_drops": dict(summary["permission_drops"]),
        "permission_drops_total": sum(summary["permission_drops"].values()),
        "model_change_events": summary["model_change_events"],
        "decision_points_by_source": dict(by_source),
        "records_per_situation": dict(by_situation),
        "records_per_model": dict(by_model),
        "records_per_situation_and_model": {
            f"{situation}:{model}": count for (situation, model), count in sorted(by_situation_model.items())
        },
        "records_per_source_and_situation": {
            f"{source}:{situation}": count for (source, situation), count in sorted(by_source_situation.items())
        },
        "class_balance": {key: round(value / len(rows), 6) for key, value in by_situation.items()} if rows else {},
        "records_per_split": dict(by_split),
        "records_per_split_and_situation": {
            f"{split}:{situation}": count for (split, situation), count in sorted(by_split_situation.items())
        },
        "sidechain_candidate_assistant_events": summary["sidechain_candidate_assistant_events"],
        "junk_model_events": summary["junk_model_events"],
        "resume_gap_events": summary["resume_gap_events"],
        "explicit_resume_decision_points": summary["explicit_resume_decision_points"],
        "feature_coverage": {
            "records_with_tool_use": sum(row["tool_use_count"] > 0 for row in rows),
            "records_with_tool_result": sum(row["tool_result_count"] > 0 for row in rows),
            "records_with_image": sum(row["image_present"] for row in rows),
            "context_size_missing": sum(row["context_size_tokens"] is None for row in rows),
            "idle_gap_ge_30_minutes": sum(gap >= 30 for gap in idle_gaps),
            "max_idle_gap_minutes": max(idle_gaps, default=None),
            "idle_gap_ge_30_minutes_in_decisions": sum(gap >= 30 for gap in idle_gaps),
            "max_turn_index": max((row["turn_index"] for row in rows), default=None),
        },
        "split_strategy": "session hash: train buckets 0-7, validation 8, test 9",
        "privacy": {
            "stored_fields": "metadata only; timestamps, hashed session ids, roles, event type, model, counts, names, lengths, flags",
            "excluded": "message text, prompts, tool arguments/results, file contents, source paths",
            "permission_filter": "drop any record with permission/approval/consent/allow/deny/grant/confirm structural keys or permission event type",
        },
        "confounds": {
            "pi_sessions": "pi source is confounded by the auto round-robin switcher; model_change_events are retained as metadata",
            "claude_sessions": "Claude Code sessions mostly reflect manual model choices",
            "sidechain_candidate_assistant_events": summary["sidechain_candidate_assistant_events"],
            "session_split": "session-hash split prevents same-session leakage",
        },
    }
    return rows, summary_out


def write_inventory(rows: list[dict[str, Any]], summary: dict[str, Any], output_dir: Path) -> None:
    output_dir.mkdir(parents=True, exist_ok=True)
    with (output_dir / "decision_points.jsonl").open("w", encoding="utf-8", newline="\n") as handle:
        for row in rows:
            handle.write(json.dumps(row, sort_keys=True, separators=(",", ":")) + "\n")
    with (output_dir / "inventory_summary.json").open("w", encoding="utf-8", newline="\n") as handle:
        json.dump(summary, handle, sort_keys=True, indent=2)
        handle.write("\n")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Build the metadata-only system-one inventory")
    parser.add_argument("--claude-root", type=Path, default=Path(r"C:/Users/cafe/.claude/projects"))
    parser.add_argument("--pi-root", type=Path, default=Path(r"C:/Users/cafe/.pi/agent/sessions"))
    parser.add_argument("--output-dir", type=Path, default=Path("data"))
    args = parser.parse_args(argv)
    live_session = os.environ.get("PI_SESSION_FILE")
    rows, summary = build_inventory(
        args.claude_root,
        args.pi_root,
        Path(live_session) if live_session else None,
    )
    write_inventory(rows, summary, args.output_dir)
    print(json.dumps({"decision_points": len(rows), "permission_drops": summary["permission_drops_total"]}, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
