# Migration notes

The repository has been consolidated into five package identities: `agent-cli-lab`, `distributed-agent-chat`, `pi-agent-extensions`, `skills`, and `system-one`.

## Package paths and installer CLI

The standalone feature package paths `packages/pi-touchbar-usage`, `packages/pi-extension-macos-browser-control`, and `packages/pi-extension-claude-cli` were merged into feature directories under `packages/pi-agent-extensions/`. Update scripts and local checkouts that refer to those old package paths. The former `packages/claude-skills` collection and `packages/agent-cli-lab/skills` skill directory have moved into root `skills/`.

The standalone `packages/pi` host/container installer CLI was removed. Its last version remains available in repository history before this change; it is not part of the current package inventory.

## Reinstall skills and avoid duplicate extensions

Reinstall the relocated lab-commander skill by running `skills/lab-commander/install.sh`. Existing symlinks to `packages/agent-cli-lab/skills/...` break after relocation. The installer also installs the `agent-cli-lab` binary and links the skill executables.

If you previously installed the standalone Pi feature packages and now load the aggregate `pi-agent-extensions` package, remove the old installed copies to avoid loading duplicate handlers.

## Repository URL

The existing repository was renamed from `TuanKietTran/agent-toolkit` (formerly at `https://github.com/TuanKietTran/agent-toolkit`) to `TuanKietTran/pi-agent-extensions`. GitHub redirects the former URL; no new repository or history rewrite was used.

## Stable runtime identities

Package consolidation did not change runtime-facing identifiers, including the `agent-cli-lab` binary, Pi provider ID `claude-cli`, model IDs, skill names, or published usage/state filenames. Update checkout and package paths, not these runtime identities.
