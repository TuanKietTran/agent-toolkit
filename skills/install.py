#!/usr/bin/env python3
"""Install skill roots and their executable tools for supported agents."""
import argparse
import os
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parent
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


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("skills", nargs="*")
    parser.add_argument("--agent", choices=[*AGENTS, "all"], default="all")
    parser.add_argument("--home", type=Path, default=Path.home())
    args = parser.parse_args(argv)
    try:
        install(args.skills, args.agent, args.home.expanduser().resolve())
    except (ValueError, RuntimeError) as exc:
        print(f"install.py: {exc}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
