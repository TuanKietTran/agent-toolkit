"""Subprocess tests for ``python -m system_one.pick`` (gl-s1)."""

from __future__ import annotations

import json
import os
import subprocess
import sys
import unittest
from pathlib import Path

PACKAGE_DIR = Path(__file__).resolve().parents[1]
SRC_DIR = PACKAGE_DIR / "src"

CATALOG = ["claude-haiku-5-5", "claude-sonnet-5-5", "claude-opus-5", "gpt-6-luna", "gpt-6-sol"]


def run_pick(stdin_text: str) -> subprocess.CompletedProcess[str]:
    env = dict(os.environ)
    env["PYTHONPATH"] = str(SRC_DIR)
    env["SYSTEM_ONE_BACKEND"] = "local"
    return subprocess.run(
        [sys.executable, "-m", "system_one.pick"],
        input=stdin_text,
        capture_output=True,
        text=True,
        cwd=PACKAGE_DIR,
        env=env,
        timeout=60,
    )


def run_scenario(scenario: dict) -> subprocess.CompletedProcess[str]:
    return run_pick(json.dumps(scenario))


def base_scenario(**overrides):
    scenario = {
        "kind": "model_pick",
        "situation": "new",
        "complexity_hint": "medium",
        "available": list(CATALOG),
        "needs_images": False,
        "context_tokens": 1000,
    }
    scenario.update(overrides)
    return scenario


class PickCliTests(unittest.TestCase):
    def test_normal_pick(self):
        proc = run_scenario(base_scenario())
        self.assertEqual(proc.returncode, 0, proc.stderr)
        lines = [line for line in proc.stdout.splitlines() if line.strip()]
        self.assertEqual(len(lines), 1)
        payload = json.loads(lines[0])
        self.assertEqual(set(payload), {"model", "rule", "reason", "degraded_level", "kind"})
        self.assertIn(payload["model"], CATALOG)
        self.assertEqual(payload["kind"], "model_pick")
        self.assertIsInstance(payload["degraded_level"], int)

    def test_single_model_catalog(self):
        proc = run_scenario(base_scenario(available=["gpt-6-luna"], complexity_hint="low"))
        self.assertEqual(proc.returncode, 0, proc.stderr)
        payload = json.loads(proc.stdout.strip())
        self.assertEqual(payload["model"], "gpt-6-luna")

    def test_empty_catalog_exit_3(self):
        proc = run_scenario(base_scenario(available=[]))
        self.assertEqual(proc.returncode, 3, proc.stdout + proc.stderr)
        self.assertEqual(json.loads(proc.stdout.strip()), {"error": "no_model_available"})

    def test_unknown_catalog_exit_3(self):
        proc = run_scenario(base_scenario(available=["not-a-real-model"]))
        self.assertEqual(proc.returncode, 3, proc.stdout + proc.stderr)
        self.assertEqual(json.loads(proc.stdout.strip()), {"error": "no_model_available"})

    def test_permission_kind_exit_4(self):
        proc = run_scenario(base_scenario(kind="permission"))
        self.assertEqual(proc.returncode, 4, proc.stdout + proc.stderr)
        self.assertEqual(json.loads(proc.stdout.strip()), {"error": "decision_kind_refused"})

    def test_garbage_input_exit_2(self):
        proc = run_pick("this is not json {")
        self.assertEqual(proc.returncode, 2, proc.stdout + proc.stderr)
        self.assertEqual(json.loads(proc.stdout.strip()), {"error": "invalid_input"})

    def test_non_object_input_exit_2(self):
        proc = run_pick("[1, 2, 3]")
        self.assertEqual(proc.returncode, 2, proc.stdout + proc.stderr)

    def test_missing_kind_defaults_to_model_pick(self):
        scenario = base_scenario()
        del scenario["kind"]
        proc = run_scenario(scenario)
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertIn(json.loads(proc.stdout.strip())["model"], CATALOG)


if __name__ == "__main__":
    unittest.main()
