# lab-commander

A skill for Pi, Claude Code, and Codex to command interactive agent sessions hosted
by `h1`. See `SKILL.md` for the supported CLI version, workflow, and cleanup.

    ./install.sh
    h1 open -n worker --cwd ~/repo -- pi --no-session
    h1 send -n worker --file BRIEF.md --paced
    h1 status -n worker
    h1 stop -n worker
