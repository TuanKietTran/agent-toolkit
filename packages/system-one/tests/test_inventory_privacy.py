import json
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from system_one.inventory import build_inventory, is_permission_event, permission_drop_reason


class InventoryPrivacyTests(unittest.TestCase):
    def test_permission_records_and_permission_fields_are_dropped(self):
        records = [
            {"type": "permission-mode", "mode": "default"},
            {"type": "user", "permissionMode": "default"},
            {"type": "assistant", "permissionDecision": "allow"},
            {"type": "assistant", "message": {"content": [{"type": "text", "text": "permission is a word"}]}},
        ]
        self.assertTrue(all(is_permission_event(record) for record in records[:3]))
        self.assertEqual(permission_drop_reason(records[0]), "permission_event_type")
        self.assertEqual(permission_drop_reason(records[1]), "permission_mode_field")
        self.assertEqual(permission_drop_reason(records[2]), "permission_mode_field")
        self.assertFalse(is_permission_event(records[3]))

    def test_permission_like_text_is_not_inspected_or_stored(self):
        record = {
            "type": "assistant",
            "message": {"content": [{"type": "text", "text": "approval allow deny"}]},
        }
        self.assertFalse(is_permission_event(record))

    def test_forty_minute_gap_is_carried_to_next_decision(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "session.jsonl"
            records = [
                {"type": "session", "sessionId": "synthetic-gap"},
                {"type": "user", "sessionId": "synthetic-gap", "timestamp": "2026-01-01T00:00:00Z", "message": {"content": "one"}},
                {"type": "assistant", "sessionId": "synthetic-gap", "timestamp": "2026-01-01T00:00:01Z", "message": {"model": "claude-sonnet-5-5", "content": [], "usage": {"input_tokens": 3}}},
                {"type": "user", "sessionId": "synthetic-gap", "timestamp": "2026-01-01T00:40:01Z", "message": {"content": "two"}},
                {"type": "assistant", "sessionId": "synthetic-gap", "timestamp": "2026-01-01T00:40:02Z", "message": {"model": "claude-sonnet-5-5", "content": [], "usage": {"input_tokens": 4}}},
            ]
            source.write_text("".join(json.dumps(record) + "\n" for record in records), encoding="utf-8")
            rows, summary = build_inventory(root, root / "missing-pi")
        self.assertEqual([row["situation"] for row in rows], ["new", "existing"])
        self.assertEqual(rows[1]["idle_gap_minutes"], 40.0)
        self.assertEqual(summary["feature_coverage"]["idle_gap_ge_30_minutes_in_decisions"], 1)

    def test_sidechain_and_junk_models_are_not_decision_points(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "session.jsonl"
            records = [
                {"type": "user", "sessionId": "synthetic-filter", "timestamp": "2026-01-01T00:00:00Z", "message": {"content": "one"}},
                {"type": "assistant", "sessionId": "synthetic-filter", "timestamp": "2026-01-01T00:00:01Z", "message": {"model": "<synthetic>", "content": [], "usage": {}}},
                {"type": "assistant", "sessionId": "synthetic-filter", "timestamp": "2026-01-01T00:00:02Z", "message": {"model": "b", "content": [], "usage": {}}},
                {"type": "assistant", "sessionId": "synthetic-filter", "isSidechain": True, "timestamp": "2026-01-01T00:00:03Z", "message": {"model": "claude-sonnet-5-5", "content": [], "usage": {}}},
                {"type": "assistant", "sessionId": "synthetic-filter", "timestamp": "2026-01-01T00:00:04Z", "message": {"model": "claude-sonnet-5-5", "content": [], "usage": {}}},
            ]
            source.write_text("".join(json.dumps(record) + "\n" for record in records), encoding="utf-8")
            rows, summary = build_inventory(root, root / "missing-pi")
        self.assertEqual(len(rows), 1)
        self.assertEqual(summary["junk_model_events"], 2)
        self.assertEqual(summary["sidechain_candidate_assistant_events"], 1)

    def test_inventory_drops_permission_records_before_labels(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "session.jsonl"
            records = [
                {"type": "session", "sessionId": "synthetic"},
                {"type": "user", "sessionId": "synthetic", "timestamp": "2026-01-01T00:00:00Z", "message": {"content": "hello"}},
                {"type": "permission-mode", "sessionId": "synthetic", "timestamp": "2026-01-01T00:00:01Z"},
                {"type": "assistant", "sessionId": "synthetic", "timestamp": "2026-01-01T00:00:02Z", "message": {"model": "claude-sonnet-5-5", "content": [], "usage": {"input_tokens": 3}}},
                {"type": "assistant", "sessionId": "synthetic", "timestamp": "2026-01-01T00:00:03Z", "permissionDecision": "allow", "message": {"model": "claude-sonnet-5-5", "content": [], "usage": {"input_tokens": 4}}},
            ]
            source.write_text("".join(json.dumps(record) + "\n" for record in records), encoding="utf-8")
            rows, summary = build_inventory(root, root / "missing-pi")
        self.assertEqual(len(rows), 1)
        self.assertEqual(summary["permission_drops_total"], 2)
        self.assertEqual(rows[0]["situation"], "new")


if __name__ == "__main__":
    unittest.main()
