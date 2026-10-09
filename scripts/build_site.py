"""Build an allowlisted static site for GitHub Pages without a CDN."""

import argparse
from pathlib import Path
import shutil


ROOT = Path(__file__).resolve().parents[1]
SITE_FILES = ("index.html", "styles.css", "styles3d.css")
SITE_DIRECTORIES = ("src", "assets")
THREE_FILES = (
    "build/three.module.js",
    "build/three.core.js",
    "examples/jsm/controls/OrbitControls.js",
    "LICENSE",
)


def build_site(destination: Path) -> Path:
    destination = destination.resolve()
    # Never merge a public build into a source, user-data or dependency folder.
    if destination == ROOT or destination in ROOT.parents:
        raise ValueError("The output must not be the project or an ancestor directory.")
    if ROOT in destination.parents and destination.relative_to(ROOT).parts[0] != "dist":
        raise ValueError("Within this project, builds must stay inside dist/.")
    if destination.exists() and any(destination.iterdir()):
        raise FileExistsError("Use an empty output directory; existing files are preserved.")

    sources = [ROOT / name for name in SITE_FILES]
    sources += [ROOT / name for name in SITE_DIRECTORIES]
    sources += [ROOT / "node_modules" / "three" / name for name in THREE_FILES]
    missing = [str(path.relative_to(ROOT)) for path in sources if not path.exists()]
    if missing:
        raise FileNotFoundError("Missing site dependency; run npm ci first: " + ", ".join(missing))

    destination.mkdir(parents=True, exist_ok=True)
    for name in SITE_FILES:
        shutil.copy2(ROOT / name, destination / name)
    for name in SITE_DIRECTORIES:
        shutil.copytree(ROOT / name, destination / name)
    for name in THREE_FILES:
        target = destination / "node_modules" / "three" / name
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(ROOT / "node_modules" / "three" / name, target)
    (destination / ".nojekyll").touch()
    return destination


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, default=ROOT / "dist")
    args = parser.parse_args()
    print(f"Static site: {build_site(args.output)}")


if __name__ == "__main__":
    main()
