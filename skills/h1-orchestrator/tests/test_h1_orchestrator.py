"""Checks that keep the h1-orchestrator skill small, agent-neutral and true to the h1 CLI."""
import os
from pathlib import Path
import re
import shutil
import subprocess
import tempfile
import unittest

SKILL = Path(__file__).resolve().parents[1]
REPO = SKILL.parents[1]
DOCS = [SKILL / "SKILL.md"]


def text(path):
    return path.read_text(encoding="utf-8")


def find_h1():
    """An h1 binary to check commands against: $H1_BIN, a local build, or PATH."""
    candidates = [os.environ.get("H1_BIN")]
    for profile in ("debug", "release"):
        for name in ("h1", "h1.exe"):
            candidates.append(str(REPO / "packages/h1/target" / profile / name))
    candidates.append(shutil.which("h1"))
    return next((c for c in candidates if c and Path(c).is_file()), None)


def h1_invocations():
    """Every `h1 ...` command line the skill shows, in code blocks or inline code."""
    found = []
    for path in DOCS:
        body = text(path)
        for block in re.findall(r"```(?:sh|bash)?\n(.*?)```", body, re.S):
            for line in block.replace("\\\n", " ").splitlines():
                line = line.split("#", 1)[0].strip()
                if line.startswith("h1 "):
                    found.append((path.name, line, True))
        for span in re.findall(r"`(h1 [^`]+)`", body):
            # `h1 --help` and `h1 <command> --help` are prose about discovery, not commands.
            if not span.split()[1].startswith(("-", "<")):
                found.append((path.name, span, False))
    return found


def help_text(h1, words):
    result = subprocess.run([h1, *words, "--help"], capture_output=True, text=True, check=False)
    return result.returncode, result.stdout + result.stderr


def subcommands(help_output):
    names, listing = set(), False
    for line in help_output.splitlines():
        if line.strip() == "Commands:":
            listing = True
            continue
        if listing:
            if not line.startswith("  "):
                break
            names.add(line.split()[0])
    return names


class SkillShapeTests(unittest.TestCase):
    def test_frontmatter_names_the_skill(self):
        head = text(SKILL / "SKILL.md").split("---")[1]
        self.assertRegex(head, r"(?m)^name: h1-orchestrator$")
        self.assertRegex(head, r"(?m)^description: >?\s*\S")

    def test_stays_minimal(self):
        # Judgment only: h1's own --help and README are the command manual.
        self.assertLessEqual(len(text(SKILL / "SKILL.md").splitlines()), 60)
        self.assertEqual(
            sorted(p.name for p in SKILL.iterdir() if p.name != "__pycache__"),
            ["README.md", "SKILL.md", "install.sh", "tests"],
        )

    def test_covers_the_orchestration_decisions(self):
        body = text(SKILL / "SKILL.md").lower()
        for topic in ("discover", "delegate", "topology", "ownership", "brief",
                      "supervise", "verify", "--run"):
            self.assertIn(topic, body)

    def test_ships_no_wrapper_scripts(self):
        self.assertFalse((SKILL / "bin").exists(), "h1 owns the runtime; the skill ships no tools")

    def test_agent_and_model_neutral(self):
        pinned = re.compile(
            r"claude-(opus|sonnet|haiku)|gpt-\d|gemini-\d|\bmuse\b|--provider\s+\S"
            r"|\b(Opus|Sonnet|Haiku) \d",
            re.I,
        )
        for path in DOCS:
            for number, line in enumerate(text(path).splitlines(), 1):
                self.assertIsNone(pinned.search(line), f"{path.name}:{number}: {line}")

    def test_no_retired_helpers(self):
        retired = re.compile(r"\b(lab-commander|lab-team|lab-watch|lab-clean|labctl)\b")
        for path in DOCS:
            self.assertIsNone(retired.search(text(path)), path.name)

    def test_never_suggests_unscoped_gc(self):
        for name, line, in_block in h1_invocations():
            words = line.split()
            if in_block and words[1] in ("gc", "release"):
                self.assertIn("--run", words, f"{name}: {line}")


class SkillMatchesCliTests(unittest.TestCase):
    """Every command and long flag the skill teaches must exist in `h1 ... --help`."""

    @classmethod
    def setUpClass(cls):
        cls.h1 = find_h1()
        if cls.h1 is None:
            raise unittest.SkipTest("no h1 binary: build packages/h1 or set H1_BIN")
        code, out = help_text(cls.h1, [])
        cls.top = subcommands(out)

    def command_words(self, line):
        words = line.split()[1:]
        path = [words[0]]
        code, out = help_text(self.h1, path)
        nested = subcommands(out)
        if nested and len(words) > 1 and words[1] in nested:
            path.append(words[1])
            code, out = help_text(self.h1, path)
        return path, code, out

    def test_commands_and_flags_exist(self):
        invocations = h1_invocations()
        self.assertGreater(len(invocations), 10)
        for name, line, _ in invocations:
            with self.subTest(doc=name, line=line):
                words = line.split()
                self.assertIn(words[1], self.top, f"unknown command h1 {words[1]}")
                path, code, out = self.command_words(line)
                self.assertEqual(code, 0, out)
                for flag in re.findall(r"(?<![\w-])(--[a-z][a-z-]*)", line.split(" -- ")[0]):
                    if flag != "--help":
                        self.assertIn(flag, out, f"h1 {' '.join(path)} has no {flag}")


@unittest.skipUnless(shutil.which("sh"), "needs sh")
class InstallScriptTests(unittest.TestCase):
    def fake(self, bindir, name, body):
        path = bindir / name
        path.write_text(f"#!/bin/sh\n{body}\n", newline="\n")
        path.chmod(0o755)

    def run_install(self, cargo_exit=0):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            bindir = root / "bin"
            bindir.mkdir()
            calls = root / "calls"
            self.fake(bindir, "cargo", f'echo "cargo $*" >> "$CALLS"; exit {cargo_exit}')
            self.fake(bindir, "python3", 'echo "python3 $*" >> "$CALLS"')
            env = dict(os.environ, CALLS=calls.as_posix())
            env["PATH"] = f"{bindir}{os.pathsep}{env['PATH']}"
            result = subprocess.run(
                ["sh", (SKILL / "install.sh").as_posix(), "--agent", "pi"],
                cwd=tmp, env=env, capture_output=True, text=True, check=False,
            )
            lines = calls.read_text().splitlines() if calls.exists() else []
            return result.returncode, lines

    def test_builds_h1_then_links_this_skill(self):
        code, lines = self.run_install()
        self.assertEqual(code, 0)
        self.assertEqual(len(lines), 2, lines)
        self.assertRegex(lines[0], r"^cargo install --locked --path .*packages/h1$")
        self.assertRegex(lines[1], r"^python3 .*install\.py h1-orchestrator --agent pi$")

    def test_failed_build_does_not_link(self):
        code, lines = self.run_install(cargo_exit=17)
        self.assertEqual(code, 17)
        self.assertEqual(len(lines), 1, lines)


if __name__ == "__main__":
    unittest.main()
