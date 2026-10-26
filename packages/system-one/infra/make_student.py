"""Regenerate data/student_model.json on any machine, without personal data.

The student is distilled from the explicit policy on SYNTHETIC scenarios (fixed seed). Training depends on Python's
string-hash order, so this script re-runs itself with PYTHONHASHSEED=0; with that pin the output is byte-identical
across runs (verified 2026-10-18: three runs, same sha256; other seeds give different but equally valid trees, because
serve.py validates every student proposal against the policy). `python -m system_one.report` would also need data/decision_points.jsonl (an inventory of the local
Claude Code and pi session logs) and rewrites REPORT.md; this script needs neither.

    python infra/make_student.py [output_path]      # default: data/student_model.json next to the repository root

serve.py falls back to the plain policy when the file is missing, so the service also runs without it.
"""
import os
import subprocess
import sys
from pathlib import Path

if os.environ.get("PYTHONHASHSEED") != "0":
    sys.exit(subprocess.call([sys.executable, *sys.argv], env={**os.environ, "PYTHONHASHSEED": "0"}))

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))

from system_one.scenarios import generate_scenarios  # noqa: E402
from system_one.student import train_student  # noqa: E402

output = Path(sys.argv[1]) if len(sys.argv) > 1 else ROOT / "data" / "student_model.json"
output.parent.mkdir(parents=True, exist_ok=True)
train_student(generate_scenarios()["train"], output)
print(f"wrote {output} ({output.stat().st_size} bytes)")
