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
        self.fixture = FILE.parent / "tests/fixtures/sample-skill"
        self.original_root = installer.ROOT
        installer.ROOT = FILE.parent
        # Inject fixture as the sample-skill source without touching the repository tree.
        self.mapping = {"sample-skill": self.fixture}

    def tearDown(self):
        installer.ROOT = self.original_root
        self.temp.cleanup()

    def run_fixture(self):
        original_discover = installer.discover
        original_root = installer.ROOT
        try:
            installer.ROOT = self.fixture.parent
            installer.discover = lambda: ["sample-skill"]
            original_link = installer.link
            def mapped_link(source, destination):
                if source == installer.ROOT / "sample-skill":
                    source = self.fixture
                original_link(source, destination)
            installer.link = mapped_link
            installer.install(["sample-skill"], "all", self.home)
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
            self.assertEqual((self.home / parent / "sample-skill").resolve(), self.fixture)
        for tool in ("tool-a", "tool-b"):
            self.assertEqual((self.home / ".local/bin" / tool).resolve(), self.fixture / "bin" / tool)

    def test_conflict_refused(self):
        dest = self.home / ".claude/skills/sample-skill"
        dest.parent.mkdir(parents=True)
        dest.write_text("keep")
        original_discover = installer.discover
        installer.discover = lambda: ["sample-skill"]
        try:
            with self.assertRaises(RuntimeError):
                installer.install(["sample-skill"], "claude", self.home)
        finally:
            installer.discover = original_discover
        self.assertEqual(dest.read_text(), "keep")

    def test_discovery_and_missing_skill(self):
        names = installer.discover()
        self.assertEqual(names, ["h1-orchestrator", "orchestrator-options"])
        with self.assertRaises(ValueError):
            installer.install(["not-a-skill"], "all", self.home)

    def test_fixture_has_two_tools(self):
        tools = [p for p in (self.fixture / "bin").iterdir() if p.is_file() and os.access(p, os.X_OK)]
        self.assertEqual(len(tools), 2)


if __name__ == "__main__":
    unittest.main()
