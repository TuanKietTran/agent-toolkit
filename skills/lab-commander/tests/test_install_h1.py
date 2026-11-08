import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest


SKILLS = Path(__file__).resolve().parents[2]
SKILL = SKILLS / "lab-commander"
INSTALL_PY = SKILLS / "install.py"
# Built at runtime so the rename grep for the old name stays empty, bytecode included.
LEGACY_BIN = "-".join(["agent", "cli", "lab"])
AGENT_SKILL_DIRS = [".claude/skills", ".codex/skills", ".pi/agent/skills"]


def run_install(home, extra_env=None, cwd=None):
    env = os.environ.copy()
    env["HOME"] = str(home)
    if extra_env:
        env.update(extra_env)
    return subprocess.run(
        [sys.executable, str(INSTALL_PY), "lab-commander"],
        env=env, cwd=cwd, capture_output=True, text=True, check=False,
    )


class InstallH1Tests(unittest.TestCase):
    def test_install_py_with_home_temp_checks_links(self):
        with tempfile.TemporaryDirectory() as tmp:
            home = Path(tmp) / "home"
            result = run_install(home, cwd=tmp)
            self.assertEqual(result.returncode, 0, result.stderr)
            for rel in AGENT_SKILL_DIRS:
                link = home / rel / "lab-commander"
                self.assertTrue(link.is_symlink(), link)
                self.assertEqual(link.resolve(), SKILL.resolve(), link)
            tools = [p for p in (SKILL / "bin").iterdir() if p.is_file() and os.access(p, os.X_OK)]
            self.assertTrue(tools)
            for tool in tools:
                link = home / ".local/bin" / tool.name
                self.assertTrue(link.is_symlink(), link)
                self.assertEqual(link.resolve(), tool.resolve(), link)
            self.assertTrue((home / ".local/bin/labctl").is_symlink())

    def test_created_tool_links_exact_set_and_h1_era_contents(self):
        expected = {"labctl", "lab-clean", "lab-gui", "lab-team", "lab-watch"}
        with tempfile.TemporaryDirectory() as tmp:
            home = Path(tmp) / "home"
            result = run_install(home, cwd=tmp)
            self.assertEqual(result.returncode, 0, result.stderr)
            created = {p.name for p in (home / ".local/bin").iterdir()}
            self.assertEqual(created, expected)
            for name in expected:
                link = home / ".local/bin" / name
                self.assertTrue(link.is_symlink(), link)
                self.assertEqual(link.resolve(), (SKILL / "bin" / name).resolve(), link)
            for path in home.rglob("*"):
                self.assertNotIn(LEGACY_BIN, path.name)
        legacy_underscore = "_".join(["agent", "cli", "lab"])
        for name in expected:
            text = (SKILL / "bin" / name).read_text()
            self.assertNotIn(LEGACY_BIN, text, name)
            self.assertNotIn(legacy_underscore, text, name)
        for name in ("labctl", "lab-clean", "lab-team", "lab-watch"):
            self.assertIn("h1", (SKILL / "bin" / name).read_text(), name)
        self.assertIn("packages/lab-gui/server.mjs", (SKILL / "bin/lab-gui").read_text())

    def test_labctl_execs_h1(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            bindir = root / "bin"
            bindir.mkdir()
            fake = bindir / "h1"
            fake.write_text("#!/bin/sh\nprintf 'h1:%s' \"$*\"\n")
            fake.chmod(0o755)
            env = os.environ.copy()
            env["PATH"] = f"{bindir}{os.pathsep}{env['PATH']}"
            result = subprocess.run(
                [str(SKILL / "bin/labctl"), "status", "-n", "worker-1"],
                env=env, capture_output=True, text=True, check=False,
            )
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(result.stdout.strip(), "h1:status -n worker-1")
            self.assertIn("exec h1", (SKILL / "bin/labctl").read_text())

    def test_old_bin_on_path_prints_one_note_and_is_not_deleted(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            home = root / "home"
            bindir = root / "bin"
            bindir.mkdir()
            old = bindir / LEGACY_BIN
            old.write_text("#!/bin/sh\nexit 0\n")
            old.chmod(0o755)
            env = {"PATH": f"{bindir}{os.pathsep}{os.environ['PATH']}"}
            result = run_install(home, extra_env=env, cwd=tmp)
            self.assertEqual(result.returncode, 0, result.stderr)
            note_lines = [line for line in result.stdout.splitlines() if LEGACY_BIN in line]
            self.assertEqual(len(note_lines), 1, result.stdout)
            self.assertTrue(old.exists())
            self.assertEqual((home / ".claude/skills/lab-commander").resolve(), SKILL.resolve())

    def test_no_old_bin_on_path_prints_no_note(self):
        with tempfile.TemporaryDirectory() as tmp:
            home = Path(tmp) / "home"
            empty = Path(tmp) / "empty"
            empty.mkdir()
            result = run_install(home, extra_env={"PATH": str(empty)}, cwd=tmp)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertNotIn(LEGACY_BIN, result.stdout)


if __name__ == "__main__":
    unittest.main()
