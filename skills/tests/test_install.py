import importlib.util
import os
from pathlib import Path
import tempfile
import unittest

FILE = Path(__file__).resolve().parents[1] / "install.py"
spec = importlib.util.spec_from_file_location("skills_install", FILE)
installer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(installer)


class InstallerTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.home = Path(self.temp.name) / "home"
        self.fixture = FILE.parent / "tests/fixtures/lab-commander"
        self.original_root = installer.ROOT
        installer.ROOT = FILE.parent
        # Inject fixture as the lab-commander source without touching the repository tree.
        self.mapping = {"lab-commander": self.fixture}

    def tearDown(self):
        installer.ROOT = self.original_root
        self.temp.cleanup()

    def run_fixture(self):
        original_discover = installer.discover
        original_root = installer.ROOT
        try:
            installer.ROOT = self.fixture.parent
            installer.discover = lambda: ["lab-commander"]
            original_link = installer.link
            def mapped_link(source, destination):
                if source == installer.ROOT / "lab-commander":
                    source = self.fixture
                original_link(source, destination)
            installer.link = mapped_link
            installer.install(["lab-commander"], "all", self.home)
        finally:
            installer.ROOT = original_root
            installer.discover = original_discover
            installer.link = original_link

    def test_fixture_links_idempotence_and_cwd_independence(self):
        cwd = Path.cwd()
        try:
            os.chdir(self.temp.name)
            self.run_fixture()
            self.run_fixture()
        finally:
            os.chdir(cwd)
        for parent in (".claude/skills", ".codex/skills", ".pi/agent/skills"):
            self.assertEqual((self.home / parent / "lab-commander").resolve(), self.fixture)
        for tool in ("labctl", "lab-watch"):
            self.assertEqual((self.home / ".local/bin" / tool).resolve(), self.fixture / "bin" / tool)

    def test_conflict_refused(self):
        dest = self.home / ".claude/skills/lab-commander"
        dest.parent.mkdir(parents=True)
        dest.write_text("keep")
        original_discover = installer.discover
        installer.discover = lambda: ["lab-commander"]
        try:
            with self.assertRaises(RuntimeError):
                installer.install(["lab-commander"], "claude", self.home)
        finally:
            installer.discover = original_discover
        self.assertEqual(dest.read_text(), "keep")

    def test_discovery_and_missing_skill(self):
        names = installer.discover()
        self.assertEqual(names, ["lab-commander", "orchestrator-options"])
        with self.assertRaises(ValueError):
            installer.install(["not-a-skill"], "all", self.home)

    def test_fixture_has_two_tools(self):
        tools = [p for p in (self.fixture / "bin").iterdir() if p.is_file() and os.access(p, os.X_OK)]
        self.assertEqual(len(tools), 2)


if __name__ == "__main__":
    unittest.main()
