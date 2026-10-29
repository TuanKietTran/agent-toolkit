import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest


SKILL = Path(__file__).resolve().parents[1]


class LabCommanderTests(unittest.TestCase):
    def executable(self, path: Path, content: str) -> None:
        path.write_text(content)
        path.chmod(0o755)

    def test_labctl_forwards_each_argument_verbatim(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            capture = root / "args.json"
            bindir = root / "bin"
            bindir.mkdir()
            self.executable(
                bindir / "agent-cli-lab",
                "#!/usr/bin/env python3\nimport json, os, sys\n"
                "json.dump(sys.argv[1:], open(os.environ['CAPTURE'], 'w'))\n",
            )
            args = ["open", "two words", "", "--value=with spaces", "*", "--", "worker"]
            env = os.environ.copy()
            env.update(PATH=f"{bindir}{os.pathsep}{env['PATH']}", CAPTURE=str(capture))
            result = subprocess.run([str(SKILL / "bin/labctl"), *args], env=env, check=False)
            self.assertEqual(result.returncode, 0)
            self.assertEqual(json.loads(capture.read_text()), args)

    def test_install_wrapper_order_paths_and_argument_delegation(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            bindir = root / "bin"
            bindir.mkdir()
            calls = root / "calls.jsonl"
            self.executable(
                bindir / "cargo",
                f"#!{sys.executable}\nimport json, os, sys\n"
                "with open(os.environ['CALLS'], 'a') as f: f.write(json.dumps(['cargo', *sys.argv[1:]])+'\\n')\n",
            )
            self.executable(
                bindir / "python3",
                f"#!{sys.executable}\nimport json, os, sys\n"
                "with open(os.environ['CALLS'], 'a') as f: f.write(json.dumps(['python3', *sys.argv[1:]])+'\\n')\n",
            )
            env = os.environ.copy()
            env.update(PATH=f"{bindir}{os.pathsep}{env['PATH']}", CALLS=str(calls))
            subprocess.run([str(SKILL / "install.sh"), "--agent", "codex", "--home", "/tmp/skill home"], cwd=tmp, env=env, check=True)
            records = [json.loads(line) for line in calls.read_text().splitlines()]
            self.assertEqual(records, [
                ["cargo", "install", "--locked", "--path", str(SKILL / "../../packages/agent-cli-lab")],
                ["python3", str(SKILL / "../install.py"), "lab-commander", "--agent", "codex", "--home", "/tmp/skill home"],
            ])

    def test_failed_binary_install_does_not_delegate(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            bindir = root / "bin"
            bindir.mkdir()
            calls = root / "calls"
            self.executable(bindir / "cargo", "#!/bin/sh\nprintf cargo >> \"$CALLS\"\nexit 17\n")
            self.executable(bindir / "python3", "#!/bin/sh\nprintf python >> \"$CALLS\"\n")
            env = os.environ.copy()
            env.update(PATH=f"{bindir}{os.pathsep}{env['PATH']}", CALLS=str(calls))
            result = subprocess.run([str(SKILL / "install.sh")], cwd=tmp, env=env, check=False)
            self.assertEqual(result.returncode, 17)
            self.assertEqual(calls.read_text(), "cargo")

    def test_relocated_shell_tests(self):
        scripts = sorted((SKILL / "tests").glob("*.sh"))
        self.assertEqual(len(scripts), 3)
        for script in scripts:
            with self.subTest(script=script.name):
                subprocess.run(["sh", str(script)], check=True, timeout=30)


if __name__ == "__main__":
    unittest.main()
