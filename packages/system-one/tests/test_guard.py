import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from system_one.guard import DecisionGuard, DecisionKindError


class DecisionGuardTests(unittest.TestCase):
    def test_default_allowlist_allows_model_pick_only(self):
        guard = DecisionGuard()
        self.assertTrue(guard.allows("model_pick"))
        with self.assertRaises(DecisionKindError):
            guard.check("permission")
        with self.assertRaises(DecisionKindError):
            guard.check("unknown_kind")

    def test_config_cannot_add_permission_style_kind(self):
        for kind in ("permission", "approval", "consent", "allow", "deny", "grant", "confirm"):
            with self.subTest(kind=kind), self.assertRaises(DecisionKindError):
                DecisionGuard.from_config({"decision_kinds": [kind]})

    def test_config_cannot_expand_compiled_allowlist(self):
        with self.assertRaises(DecisionKindError):
            DecisionGuard.from_config({"decision_kinds": ["model_pick", "model_route"]})


if __name__ == "__main__":
    unittest.main()
