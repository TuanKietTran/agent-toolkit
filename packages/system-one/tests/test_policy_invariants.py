import ast
import random
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from system_one.guard import DecisionGuard, DecisionKindError
from system_one.policy import Decision, MODEL_SPECS, NoModelAvailable, TIER_MODELS, is_usable, pick_model
from system_one.scenarios import all_scenarios, generate_scenarios
from system_one.student import load_predictor, train_student


class PolicyInvariantTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        groups = generate_scenarios(total=10002, seed=20261014, ood_total=0)
        cls.cases = all_scenarios(groups)
        cls.temp = tempfile.TemporaryDirectory()
        path = Path(cls.temp.name) / "student.json"
        train_student(groups["train"], path)
        cls.predictor = load_predictor(path)

    @classmethod
    def tearDownClass(cls):
        cls.temp.cleanup()

    def test_forbidden_option_tokens_are_absent_from_decision_surfaces(self):
        forbidden = ("ask", "user", "human", "confirm", "defer", "escalate", "abstain", "unknown", "none")
        fields = set(Decision.__dataclass_fields__)
        self.assertFalse(any(token in field.lower() for field in fields for token in forbidden))
        payload = __import__("json").loads((Path(self.temp.name) / "student.json").read_text(encoding="utf-8"))
        labels = payload["classes"]
        self.assertTrue(labels)
        self.assertFalse(any(token in label.lower() for label in labels for token in forbidden))
        for module_path in ("policy.py", "scenarios.py", "student.py"):
            path = Path(__file__).resolve().parents[1] / "src" / "system_one" / module_path
            tree = ast.parse(path.read_text(encoding="utf-8"))
            literals = [node.value for node in ast.walk(tree) if isinstance(node, ast.Constant) and isinstance(node.value, str)]
            self.assertFalse(any(token in literal.lower() for literal in literals for token in forbidden), module_path)

    def test_at_least_ten_thousand_policy_and_student_decisions_are_safe(self):
        self.assertGreaterEqual(len(self.cases), 10_000)
        for case in self.cases:
            usable = [model for model in case["available"] if is_usable(case, model)]
            self.assertTrue(case["available"])
            policy = pick_model(case)
            student = self.predictor.predict(case)
            self.assertIn(policy.model, case["available"])
            self.assertIn(student.model, case["available"])
            if usable:
                self.assertIn(policy.model, usable)
                self.assertIn(student.model, usable)
            for decision in (policy, student):
                self.assertIn(decision.model, case["available"])
                if case["needs_images"]:
                    self.assertTrue(MODEL_SPECS[decision.model].supports_images)
            if case["situation"] in {"existing", "continuing"} and is_usable(case, case["prev_model"]):
                self.assertEqual(policy.model, case["prev_model"])
                self.assertEqual(student.model, case["prev_model"])
            tier_models = [model for model in TIER_MODELS[case["complexity_hint"]] if is_usable(case, model)]
            if case["situation"] == "new" and tier_models:
                self.assertIn(policy.model, tier_models)
                self.assertIn(student.model, tier_models)

    def test_unfiltered_twenty_thousand_fuzz_cases_decide(self):
        rng = random.Random(7)
        models = list(MODEL_SPECS)
        for _ in range(20_000):
            available = frozenset(rng.sample(models, rng.randint(1, len(models))))
            case = {
                "situation": rng.choice(["new", "existing", "continuing"]),
                "prev_model": rng.choice(models + [""]),
                "idle_gap_minutes": rng.choice([0, 1, 31, 5000]),
                "complexity_hint": rng.choice(["low", "medium", "high"]),
                "context_tokens": rng.choice([0, 1000, 50_000, 150_000, 220_000, 300_000, 900_000]),
                "needs_images": rng.random() < 0.3,
                "available": available,
                "headroom": {"claude": rng.choice([0, .05, .5, 1.0]), "codex": rng.choice([0, .05, .5, 1.0])},
            }
            strict = [model for model in available if is_usable(case, model)]
            policy = pick_model(case)
            student = self.predictor.predict(case)
            self.assertIn(policy.model, available)
            self.assertIn(student.model, available)
            if strict:
                self.assertIn(policy.model, strict)
                self.assertIn(student.model, strict)

    def test_missing_headroom_means_unmeasured_not_exhausted(self):
        minimal = pick_model({"situation": "new", "complexity_hint": "medium"})
        explicit_zero = pick_model({"situation": "new", "complexity_hint": "medium", "headroom": {"claude": 0, "codex": 0}})
        none_value = pick_model({"situation": "new", "complexity_hint": "medium", "headroom": {"claude": None, "codex": None}})
        self.assertEqual(minimal.degraded_level, 0)
        self.assertEqual(none_value.degraded_level, 0)
        self.assertEqual(none_value.model, minimal.model)
        self.assertEqual(explicit_zero.degraded_level, 2)

    def test_legacy_models_are_hold_only_for_new_picks(self):
        case = {
            "situation": "new", "prev_model": "", "complexity_hint": "medium",
            "context_tokens": 1000, "needs_images": False,
            "available": {"claude-sonnet-5", "claude-sonnet-5-5"},
            "headroom": {"claude": 1.0, "codex": 0.0},
        }
        self.assertEqual(pick_model(case).model, "claude-sonnet-5-5")

    def test_audit_hand_cases_and_malformed_inputs_decide(self):
        base = {
            "situation": "continuing", "prev_model": "claude-sonnet-5-5", "idle_gap_minutes": 1,
            "complexity_hint": "medium", "context_tokens": 1000, "needs_images": False,
            "available": frozenset(MODEL_SPECS), "headroom": {"claude": 1.0, "codex": 1.0},
        }
        cases = [
            {**base, "context_tokens": 500_000},
            {**base, "headroom": {"claude": 0.0, "codex": 0.0}},
            {**base, "available": frozenset({"claude-haiku-5-5"}), "headroom": {"claude": 0.0, "codex": 0.0}},
            {**base, "situation": "bogus"},
            {**base, "complexity_hint": "extreme"},
            {**base, "hard_cap": 2.0},
        ]
        for case in cases:
            policy = pick_model(case)
            student = self.predictor.predict(case)
            self.assertIn(policy.model, case["available"])
            self.assertIn(student.model, case["available"])

    def test_ambiguous_and_low_confidence_cases_still_decide(self):
        difficult = [case for case in self.cases if case["case_kind"] in {"ambiguous", "low_confidence"}]
        self.assertTrue(difficult)
        for case in difficult:
            usable = [model for model in case["available"] if is_usable(case, model)]
            self.assertTrue(usable)
            self.assertIn(pick_model(case).model, usable)
            self.assertIn(self.predictor.predict(case).model, usable)

    def test_no_usable_model_is_an_error(self):
        case = {
            "situation": "new",
            "prev_model": "",
            "idle_gap_minutes": 0,
            "complexity_hint": "medium",
            "context_tokens": 300_000,
            "needs_images": True,
            "available": [],
            "headroom": {"claude": 0.0, "codex": 0.0},
            "hard_cap": 0.9,
        }
        with self.assertRaises(NoModelAvailable):
            pick_model(case)

    def test_permission_style_kinds_are_refused(self):
        with self.assertRaises(DecisionKindError):
            DecisionGuard.from_config({"decision_kinds": ["approval"]})
        with self.assertRaises(DecisionKindError):
            DecisionGuard().check("allow")
        with self.assertRaises(DecisionKindError):
            Decision("model", "R1", "reason", kind="consent")


if __name__ == "__main__":
    unittest.main()
