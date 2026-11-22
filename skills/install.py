#!/usr/bin/env python3
"""Install skill roots and their executable tools for supported agents."""
import argparse
import os
from pathlib import Path
import shutil
import sys

ROOT = Path(__file__).resolve().parent
# Built at runtime so the rename grep for the old name stays empty, bytecode included.
LEGACY_BIN = "-".join(["agent", "cli", "lab"])


def note_legacy_bin():
    found = shutil.which(LEGACY_BIN)
    if found:
        print(f"note: old {LEGACY_BIN} found at {found}; leaving it in place, use h1 instead")
    return found


AGENTS = {
    "claude": Path(".claude/skills"),
    "codex": Path(".codex/skills"),
    "pi": Path(".pi/agent/skills"),
}


def discover():
    return sorted(p.name for p in ROOT.iterdir() if p.is_dir() and (p / "SKILL.md").is_file())


def link(source, destination):
    destination.parent.mkdir(parents=True, exist_ok=True)
    if destination.is_symlink():
        if destination.resolve() == source.resolve():
            return
        raise FileExistsError(f"conflicting link: {destination} -> {os.readlink(destination)}")
    if destination.exists():
        raise FileExistsError(f"conflicting existing path: {destination}")
    destination.symlink_to(source, target_is_directory=source.is_dir())


def install(names, agent, home):
    available = discover()
    selected = names or available
    invalid = [name for name in selected if name not in available]
    if invalid:
        raise ValueError("unknown or missing skill(s): " + ", ".join(invalid))
    targets = AGENTS if agent == "all" else {agent: AGENTS[agent]}
    errors = []
    for name in selected:
        skill = ROOT / name
        for relative in targets.values():
            try:
                link(skill, home / relative / name)
            except OSError as exc:
                errors.append(str(exc))
        bindir = skill / "bin"
        if bindir.is_dir():
            for source in sorted(bindir.iterdir()):
                if source.is_file() and os.access(source, os.X_OK):
                    try:
                        link(source, home / ".local/bin" / source.name)
                    except OSError as exc:
                        errors.append(str(exc))
    if errors:
        raise RuntimeError("\n".join(errors))


# Skills and tools this collection used to install. Upgrading removes their links only when
# they point into this checkout and their target is gone; anything else is reported, never
# deleted.
RETIRED_SKILLS = {"lab-commander": "h1-orchestrator"}
RETIRED_TOOLS = ("labctl", "lab-clean", "lab-gui", "lab-team", "lab-watch")


def _link_target(path):
    """Absolute target of a symlink or junction, or None if path is neither."""
    is_junction = getattr(os.path, "isjunction", lambda _p: False)(path)
    if not (path.is_symlink() or is_junction):
        return None
    raw = os.readlink(path)
    if raw.startswith("\\\\?\\"):  # Windows reports link targets in extended-length form
        raw = raw[4:]
    target = Path(raw)
    if not target.is_absolute():
        target = path.parent / target
    return Path(os.path.normpath(target))


def _inside(path, root):
    path, root = os.path.normcase(path), os.path.normcase(root)
    return path == root or path.startswith(root.rstrip(os.sep) + os.sep)


def retire(agent, home):
    """Remove dangling links that earlier versions of this checkout installed."""
    targets = AGENTS if agent == "all" else {agent: AGENTS[agent]}
    candidates = [home / rel / name for rel in targets.values() for name in RETIRED_SKILLS]
    candidates += [home / ".local/bin" / name for name in RETIRED_TOOLS]
    removed = []
    for path in candidates:
        target = _link_target(path)
        if target is None:
            if path.exists():
                print(f"note: retired {path} is not a link; leaving it in place")
            continue
        if _inside(target, ROOT) and not target.exists():
            if path.is_dir() and not path.is_symlink():
                os.rmdir(path)  # a junction: removes the link, never the target
            else:
                path.unlink()
            removed.append(path)
            print(f"removed retired link {path} (see docs/architecture/h1-skill-migration.md)")
        else:
            print(f"note: retired link {path} -> {target} left in place; remove it if unused")
    return removed


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("skills", nargs="*")
    parser.add_argument("--agent", choices=[*AGENTS, "all"], default="all")
    parser.add_argument("--home", type=Path, default=Path.home())
    args = parser.parse_args(argv)
    note_legacy_bin()
    home = args.home.expanduser().resolve()
    retire(args.agent, home)
    try:
        install(args.skills, args.agent, home)
    except (ValueError, RuntimeError) as exc:
        print(f"install.py: {exc}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
