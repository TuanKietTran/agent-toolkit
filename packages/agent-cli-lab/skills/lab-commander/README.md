# lab-commander

A skill for Pi, Claude Code, and Codex to command interactive agent sessions hosted
by `agent-cli-lab`. See `SKILL.md` for the supported CLI version, workflow, and cleanup.

    ./install.sh
    agent-cli-lab open -n worker --cwd ~/repo -- pi --no-session
    agent-cli-lab send -n worker --file BRIEF.md --paced
    agent-cli-lab status -n worker
    agent-cli-lab stop -n worker
