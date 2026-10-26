"""Text-preserving llama-swap integration helpers.

All mutating operations act only on the caller-supplied config path. Tests use
synthetic temporary configs; this module never locates or edits a system install.
"""

from __future__ import annotations

import argparse
import difflib
import os
import re
import sys
import urllib.error
import urllib.request
from datetime import datetime
from pathlib import Path
from typing import Iterable

PROJECT_ROOT = Path(__file__).resolve().parents[2]
GROUP_BLOCK = '''groups:
  "system-one-group":
    swap: false
    exclusive: false
    persistent: true
    members:
      - "system-one"
'''


def _win(path: Path) -> str:
    return str(path.resolve()).replace("/", "\\")


def _yaml_scalar(value: str) -> str:
    if "\\" in value:
        return "'" + value.replace("'", "''") + "'"
    return '"' + value.replace('"', '\\"') + '"'


def model_block(project_root: Path = PROJECT_ROOT, python_path: Path | None = None) -> str:
    python = python_path or (project_root / ".venv" / "Scripts" / "python.exe")
    if python_path is None and not python.is_file():
        python = Path(sys.executable)
    source = _win(project_root / "src")
    student = _win(project_root / "data" / "student_model.json")
    return (
        '  "system-one":\n'
        '    cmd: >\n'
        f'      {_win(python)} -m system_one.serve --port ${{PORT}} --host 127.0.0.1\n'
        '    env:\n'
        f'      - {_yaml_scalar(f"PYTHONPATH={source}")}\n'
        f'      - {_yaml_scalar(f"SYSTEM_ONE_STUDENT={student}")}\n'
        '    proxy: http://127.0.0.1:${PORT}\n'
        '    checkEndpoint: /health\n'
        '    ttl: 0\n'
    )


def snippet(project_root: Path = PROJECT_ROOT, python_path: Path | None = None) -> str:
    return model_block(project_root, python_path) + GROUP_BLOCK


def _newline(text: str) -> str:
    return "\r\n" if "\r\n" in text else "\n"


def _lines(text: str) -> list[str]:
    return text.splitlines(keepends=True)


def _indent(line: str) -> int:
    return len(line) - len(line.lstrip(" "))


def _section(lines: list[str], name: str) -> tuple[int, int] | None:
    start = next((i for i, line in enumerate(lines) if line.strip() == f"{name}:" and _indent(line) == 0), None)
    if start is None:
        return None
    end = next((i for i in range(start + 1, len(lines)) if line_is_top_level(lines[i])), len(lines))
    return start, end


def line_is_top_level(line: str) -> bool:
    return bool(line.strip()) and _indent(line) == 0 and not line.lstrip().startswith("#")


def _key_name(line: str) -> str | None:
    if _indent(line) != 2:
        return None
    match = re.match(r'^\s{2}["\']?([^"\':]+)["\']?:\s*(?:#.*)?(?:\r?\n)?$', line)
    return match.group(1).strip() if match else None


def _entry_range(lines: list[str], section: tuple[int, int], key: str) -> tuple[int, int] | None:
    start, end = section
    for i in range(start + 1, end):
        if _key_name(lines[i]) == key:
            finish = next((j for j in range(i + 1, end) if _key_name(lines[j]) is not None), end)
            while finish > i + 1 and not lines[finish - 1].strip():
                finish -= 1
            return i, finish
    return None


def _replace_entry(lines: list[str], section: tuple[int, int], key: str, block: str, newline: str) -> tuple[list[str], bool]:
    existing = _entry_range(lines, section, key)
    replacement = _lines(block.replace("\n", newline))
    if existing is None:
        insert_at = section[1]
        result = lines[:insert_at] + replacement + lines[insert_at:]
        return result, True
    old = "".join(lines[existing[0]:existing[1]])
    new = "".join(replacement)
    if old == new:
        return lines, False
    return lines[:existing[0]] + replacement + lines[existing[1]:], True


def _ensure_terminal_newline(lines: list[str], newline: str) -> list[str]:
    if not lines:
        return lines
    if not lines[-1].endswith(("\n", "\r")):
        lines[-1] += newline
    return lines


def _install_text(text: str) -> tuple[str, bool]:
    newline = _newline(text)
    lines = _lines(text)
    models = _section(lines, "models")
    if models is None:
        raise ValueError("config has no top-level models: key")
    lines, changed_model = _replace_entry(lines, models, "system-one", model_block(), newline)
    groups = _section(lines, "groups")
    changed_group = False
    if groups is None:
        lines = _ensure_terminal_newline(lines, newline)
        if lines and lines[-1].strip():
            lines.append(newline)
        lines.extend(_lines(GROUP_BLOCK.replace("\n", newline)))
        changed_group = True
    else:
        lines, changed_group = _replace_entry(lines, groups, "system-one-group", GROUP_BLOCK.split("\n", 1)[1], newline)
    return "".join(lines), changed_model or changed_group


def _remove_entry(lines: list[str], section_name: str, key: str) -> tuple[list[str], bool, bool]:
    section = _section(lines, section_name)
    if section is None:
        return lines, False, False
    entry = _entry_range(lines, section, key)
    if entry is None:
        return lines, False, False
    start, end = entry
    return lines[:start] + lines[end:], True, start == section[0] + 1


def _uninstall_text(text: str) -> tuple[str, bool]:
    lines = _lines(text)
    lines, removed_model, _ = _remove_entry(lines, "models", "system-one")
    lines, removed_group, _ = _remove_entry(lines, "groups", "system-one-group")
    groups = _section(lines, "groups")
    if groups is not None:
        content = [line for line in lines[groups[0] + 1:groups[1]] if line.strip() and not line.lstrip().startswith("#")]
        if not content:
            lines = lines[:groups[0]] + lines[groups[1]:]
    return "".join(lines), removed_model or removed_group


def _validate(text: str, require_entry: bool = True) -> None:
    try:
        import yaml  # type: ignore
    except ImportError:
        if "models:" not in text or (require_entry and '"system-one":' not in text):
            raise ValueError("structural validation failed")
        return
    parsed = yaml.safe_load(text)
    if not isinstance(parsed, dict) or not isinstance(parsed.get("models"), dict) or (require_entry and "system-one" not in parsed["models"]):
        raise ValueError("YAML validation failed")


def _backup(path: Path, text: str) -> Path:
    stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    backup = path.with_name(f"{path.name}.bak-{stamp}-system-one")
    suffix = 1
    while backup.exists():
        backup = path.with_name(f"{path.name}.bak-{stamp}-system-one-{suffix}")
        suffix += 1
    _write_preserve(backup, text)
    return backup


def _read_preserve(path: Path) -> str:
    with path.open("r", encoding="utf-8", newline="") as handle:
        return handle.read()


def _write_preserve(path: Path, text: str) -> None:
    with path.open("w", encoding="utf-8", newline="") as handle:
        handle.write(text)


def edit_config(path: Path, install: bool, dry_run: bool = False) -> tuple[bool, str]:
    if not path.is_file():
        raise ValueError("config file does not exist")
    if not os.access(path, os.W_OK):
        raise PermissionError("config file is not writable")
    old = _read_preserve(path)
    new, changed = _install_text(old) if install else _uninstall_text(old)
    if not changed:
        return False, ""
    if dry_run:
        diff = "".join(difflib.unified_diff(old.splitlines(True), new.splitlines(True), fromfile=str(path), tofile=str(path)))
        return True, diff
    _validate(new, install)
    _backup(path, old)
    _write_preserve(path, new)
    return True, ""


def detect(timeout: float = 0.3) -> str | None:
    bases = []
    configured = os.environ.get("LLAMA_SWAP_URL")
    if configured:
        bases.append(configured.rstrip("/"))
    else:
        bases.extend(("http://127.0.0.1:8600", "http://127.0.0.1:8080"))
    for base in bases:
        try:
            with urllib.request.urlopen(f"{base}/v1/models", timeout=timeout) as response:
                payload = json_load(response.read())
            data = payload.get("data", []) if isinstance(payload, dict) else []
            if any(isinstance(item, dict) and item.get("id") == "system-one" for item in data):
                return base
        except (OSError, ValueError):
            continue
    return None


def json_load(raw: bytes) -> object:
    import json
    return json.loads(raw.decode("utf-8"))


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Manage a text-level system-one llama-swap config")
    parser.add_argument("action", choices=("show", "detect", "install", "uninstall"))
    parser.add_argument("--config", type=Path)
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args(argv)
    if args.action == "show":
        print(snippet(), end="")
        return 0
    if args.action == "detect":
        print(detect() or "none")
        return 0
    if args.config is None:
        parser.error("--config is required for install/uninstall")
    try:
        changed, output = edit_config(args.config, args.action == "install", args.dry_run)
        if args.dry_run:
            print(output, end="")
        elif changed:
            print(f"{'installed' if args.action == 'install' else 'uninstalled'}: {args.config}")
        else:
            print("no changes")
        return 0
    except (OSError, ValueError, PermissionError) as error:
        print(f"error: {error}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
