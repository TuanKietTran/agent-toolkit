# lab-commander

One skill and one CLI (`labctl`) that let Pi, Claude Code or Codex act as commander over
interactive agent CLIs hosted by agent-cli-lab (this repo). Spawn, brief, monitor,
checkpoint, resume after a usage reset, close. See `SKILL.md` for the protocol.

    ./install.sh
    labctl spawn mgr --agent claude --model claude-haiku-5-5 --cwd ~/repo
    labctl ask mgr -f BRIEF.md
    labctl wait mgr && labctl close --all

State: `$LABCTL_HOME` (default `~/.lab-commander`): `labs/*.json`, `ledger.jsonl`, recordings.
