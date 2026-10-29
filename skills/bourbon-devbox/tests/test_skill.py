import pathlib
import re
import unittest


ROOT = pathlib.Path(__file__).resolve().parents[1]


class BourbonSkillTests(unittest.TestCase):
    def test_metadata_and_resources(self):
        skill = (ROOT / "SKILL.md").read_text()
        match = re.match(r"\A---\n(.*?)\n---\n", skill, re.S)
        self.assertIsNotNone(match, "SKILL.md must have YAML frontmatter")
        metadata = match.group(1)
        self.assertRegex(metadata, r"(?m)^name: bourbon-devbox$")
        self.assertRegex(metadata, r"(?m)^description: .+")
        self.assertRegex(metadata, r"(?m)^argument-hint: .+")
        for resource, executable in (("scripts/devctl", True), ("scripts/devctl-bourbon-local", False)):
            path = ROOT / resource
            self.assertTrue(path.is_file(), resource)
            self.assertEqual(bool(path.stat().st_mode & 0o111), executable, resource)

    def test_shell_syntax(self):
        import subprocess
        for script in ("scripts/devctl", "scripts/devctl-bourbon-local"):
            result = subprocess.run(["bash", "-n", str(ROOT / script)], capture_output=True, text=True)
            self.assertEqual(result.returncode, 0, result.stderr)


if __name__ == "__main__":
    unittest.main()
