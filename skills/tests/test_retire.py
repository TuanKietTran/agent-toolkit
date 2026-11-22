"""Upgrade path: links left by the retired lab-commander skill are removed safely."""
import contextlib
import importlib.util
import io
from pathlib import Path
import tempfile
import unittest

FILE = Path(__file__).resolve().parents[1] / "install.py"
spec = importlib.util.spec_from_file_location("skills_install_retire", FILE)
installer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(installer)


def symlinks_available():
    with tempfile.TemporaryDirectory() as directory:
        try:
            (Path(directory) / "link").symlink_to(directory, target_is_directory=True)
        except OSError:
            return False
    return True


@unittest.skipUnless(symlinks_available(), "symlinks are not available here")
class RetireTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        base = Path(self.temp.name)
        self.home = base / "home"
        self.checkout = base / "checkout" / "skills"
        self.checkout.mkdir(parents=True)
        self.original_root = installer.ROOT
        installer.ROOT = self.checkout

    def tearDown(self):
        installer.ROOT = self.original_root
        self.temp.cleanup()

    def dangling(self, link, target):
        link.parent.mkdir(parents=True, exist_ok=True)
        link.symlink_to(target, target_is_directory=True)
        self.assertFalse(link.exists())  # target already gone, as after an upgrade

    def retire(self, agent="all"):
        with contextlib.redirect_stdout(io.StringIO()) as out:
            removed = installer.retire(agent, self.home)
        return removed, out.getvalue()

    def test_removes_dangling_links_into_this_checkout(self):
        skill_links = [self.home / rel / "lab-commander" for rel in installer.AGENTS.values()]
        tool_links = [self.home / ".local/bin" / name for name in installer.RETIRED_TOOLS]
        for link in skill_links:
            self.dangling(link, self.checkout / "lab-commander")
        for link in tool_links:
            self.dangling(link, self.checkout / "lab-commander/bin" / link.name)
        removed, _ = self.retire()
        self.assertEqual(sorted(removed), sorted(skill_links + tool_links))
        for link in skill_links + tool_links:
            self.assertFalse(link.is_symlink(), link)

    def test_keeps_links_into_other_checkouts_and_real_files(self):
        other = Path(self.temp.name) / "other" / "lab-commander"
        other.mkdir(parents=True)
        foreign = self.home / ".claude/skills/lab-commander"
        foreign.parent.mkdir(parents=True)
        foreign.symlink_to(other, target_is_directory=True)
        real = self.home / ".local/bin/labctl"
        real.parent.mkdir(parents=True)
        real.write_text("#!/bin/sh\n")
        removed, out = self.retire()
        self.assertEqual(removed, [])
        self.assertTrue(foreign.is_symlink())
        self.assertEqual(real.read_text(), "#!/bin/sh\n")
        self.assertIn("left in place", out)
        self.assertIn("not a link", out)

    def test_keeps_live_link_into_this_checkout(self):
        live = self.checkout / "lab-commander"
        live.mkdir()
        link = self.home / ".codex/skills/lab-commander"
        link.parent.mkdir(parents=True)
        link.symlink_to(live, target_is_directory=True)
        removed, _ = self.retire()
        self.assertEqual(removed, [])
        self.assertTrue(link.is_symlink())

    def test_agent_filter_limits_skill_dirs(self):
        claude = self.home / ".claude/skills/lab-commander"
        pi = self.home / ".pi/agent/skills/lab-commander"
        for link in (claude, pi):
            self.dangling(link, self.checkout / "lab-commander")
        removed, _ = self.retire("pi")
        self.assertEqual(removed, [pi])
        self.assertTrue(claude.is_symlink())

    def test_retire_is_idempotent(self):
        self.dangling(self.home / ".local/bin/lab-watch", self.checkout / "lab-commander/bin/lab-watch")
        self.retire()
        removed, _ = self.retire()
        self.assertEqual(removed, [])


if __name__ == "__main__":
    unittest.main()
