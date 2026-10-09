from pathlib import Path
import tempfile
import unittest

from scripts.build_site import ROOT, THREE_FILES, build_site


class SiteBuildTests(unittest.TestCase):
    def test_site_contains_runtime_but_no_workspace_data(self):
        with tempfile.TemporaryDirectory(prefix="canberra-site-") as directory:
            output = build_site(Path(directory) / "site")
            self.assertTrue((output / "index.html").is_file())
            self.assertTrue((output / "src" / "app3d.js").is_file())
            self.assertTrue((output / "assets" / "mission-patch.svg").is_file())
            self.assertTrue((output / ".nojekyll").is_file())
            for name in THREE_FILES:
                self.assertTrue((output / "node_modules" / "three" / name).is_file())
            for name in (".git", ".github", "output", "tests", "scripts", "README.md", "serve.py"):
                self.assertFalse((output / name).exists(), name)
            with self.assertRaises(FileExistsError):
                build_site(output)

    def test_source_and_parent_output_are_rejected(self):
        for directory in (ROOT, ROOT.parent, ROOT / "src", ROOT / "node_modules"):
            with self.assertRaises(ValueError):
                build_site(directory)


if __name__ == "__main__":
    unittest.main()
