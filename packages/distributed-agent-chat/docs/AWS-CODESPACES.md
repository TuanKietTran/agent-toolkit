# Two-node PoC: AWS + GitHub Codespaces

A minimal proof that two machines can serve **one shared chat room**. Everything agent-related in this PoC is **MOCK** (no LLM is called, no provider quota is used). The Cloudflare / Durable Object path is untouched; `npm run dev`, `npm run build` and `npm test` work as before.

## Design (3 lines)

1. **Node mode** (`src/node-server.ts`) runs the *unchanged* `src/worker.ts` + `Room` logic in plain Node 22, with one SQLite file per room (`node:sqlite`), so no Cloudflare account is needed.
2. **AWS node A = room owner**: one `t4g.micro` (Amazon Linux 2023) running the Node server, a MOCK `pi` worker and Caddy for HTTPS (`<ip>.sslip.io`, Let's Encrypt). Only tcp/443 is open; every API call needs a token.
3. **Codespace node B = gateway**: the same server started with `UPSTREAM_URL=<node A>`; it serves the UI and token-checks locally, then forwards room calls to A, plus a MOCK `claude` worker. Both nodes therefore show **the same room history**; a message sent on either node is answered by the worker on the other.

Limits (PoC): node A is the single source of truth. There is no failover or replication: if A is down, B answers `502 Room owner node unavailable`. One room per worker (`ROOM=demo`).

## Files

| Path | Purpose |
| --- | --- |
| `src/node-server.ts` | Node HTTP adapter + `node:sqlite` storage shim; owner or gateway (`UPSTREAM_URL`) |
| `scripts/node-up.ts` | `npm run node:up`: server + one MOCK worker in one terminal |
| `scripts/bundle-node.mjs` | `npm run build:node`: two minified bundles in `dist/` for hosts without a checkout |
| `deploy/aws/deploy.sh` · `bootstrap.sh` · `install-app.sh` | create the tagged AWS node; `bootstrap.sh` is the (secret-free) EC2 user-data; `install-app.sh` ships the app over SSM |
| `deploy/aws/terraform/` | the same AWS setup as Terraform (validated and planned, not applied); see its README |
| `deploy/aws/teardown.sh` | delete exactly the `project=dac-poc` resources |
| `deploy/aws/verify.mjs` | prints PASS/FAIL evidence that two nodes share a room |
| `scripts/gh-accounts.mjs` | GitHub account manager (below) |
| `../../.devcontainer/distributed-agent-chat/devcontainer.json` | Codespace config (repo root) |
| `test/node-server.test.ts`, `test/gh-accounts.test.ts` | automated tests for the new code |

## Run on AWS

Prerequisites: AWS CLI logged in (region `us-east-1`), `openssl`, `python3`, Node 22+ (for the bundle build).

`EXPECTED_AWS_ACCOUNT_ID` must be set before `deploy.sh up`, to the AWS account ID you expect to deploy to; `up` exits if it is unset or does not match the current account.

```sh
cd packages/distributed-agent-chat
npm ci
deploy/aws/deploy.sh up          # ~5 min; prints https://<ip>.sslip.io
deploy/aws/deploy.sh status
deploy/aws/teardown.sh           # when done: deletes everything tagged project=dac-poc
```

What `deploy.sh up` creates, all tagged `project=dac-poc`: 1 EC2 `t4g.micro` (8 GB gp3, IMDSv2 only, auto-assigned public IPv4, no Elastic IP), 1 security group (tcp/443 only, no SSH), 1 IAM role + instance profile `dac-poc-ssm` (SSM agent + read of one parameter), 1 SecureString parameter `/dac-poc/env`. The app and secrets are installed over SSM Run Command; the secrets are read on the instance from the parameter, never passed on a command line.

Secrets: the three tokens are generated once into `~/.dac-poc/env` (mode 0600, outside git). Read them from there; do not paste them into URLs or commands.

The same resources are written as Terraform in `deploy/aws/terraform/` (`terraform init && terraform apply`); use either that or the shell scripts for one deployment, not both.

Cost: about **USD 0.33/day** (t4g.micro 0.0084/h + public IPv4 0.005/h + 8 GB gp3). Teardown stops all of it.

## Run in a GitHub Codespace

Done by you (nothing here creates or pushes anything):

1. Push the repository, then in GitHub: **Settings → Secrets and variables → Codespaces → New repository secret** (or user secret scoped to the repo) and add, with the values from `~/.dac-poc/env`:
   `CHAT_TOKEN`, `PI_TOKEN`, `CLAUDE_TOKEN` (the same three as AWS) and `UPSTREAM_URL` (the `https://<ip>.sslip.io` printed by `deploy.sh up`).
2. **Code → Codespaces → ⋯ → New with options**, choose the dev container configuration **distributed-agent-chat (Codespace node)**. It uses Node 22 and runs `npm ci` automatically.
3. In the Codespace terminal:
   ```sh
   cd packages/distributed-agent-chat
   npm run node:up        # gateway on :18890 + MOCK claude worker for room "demo"
   ```
4. Open the forwarded port **18890** (Ports tab, private visibility), connect to room `demo` and enter `CHAT_TOKEN` in the page. Send a message to **pi** (answered by the AWS worker) and to **claude** (answered by the Codespace worker); both appear on the AWS node too.

## Verifying (what was run)

```sh
# Terminal 1: node B stand-in (what the Codespace runs: gateway to AWS + MOCK claude worker)
( set -a; . ~/.dac-poc/env; set +a; UPSTREAM_URL=https://<ip>.sslip.io PORT=18891 NODE_NAME=codespace-standin npm run node:up )
# Terminal 2: evidence (secrets are read from the environment and never printed)
node --env-file=$HOME/.dac-poc/env deploy/aws/verify.mjs https://<ip>.sslip.io http://127.0.0.1:18891
```

A Codespace cannot be started from a script, so the second node is run on a laptop with the same commands the devcontainer uses.

## gh-accounts (GitHub account manager)

`scripts/gh-accounts.mjs` wraps the `gh` CLI (no dependencies, never prints tokens). Run with `npm run gh-accounts -- <command>` or `node scripts/gh-accounts.mjs <command>`; `npm link` also installs a `gh-accounts` command.

```sh
gh-accounts list                              # accounts, * marks the active one
gh-accounts switch <user>                     # gh auth switch
gh-accounts add                               # device-flow login: you finish it in the browser
gh-accounts remove <user> --yes               # gh auth logout for one account
gh-accounts map ~/code/work-repo <user>       # remember dir -> account; sets the repo's git user.name/user.email
gh-accounts current ~/code/work-repo          # mapped vs. active account
gh-accounts use ~/code/work-repo              # switch gh to the mapped account
gh-accounts run --dir ~/code/work-repo -- git push          # switch, run, then restore the previous account
gh-accounts run --dir ~/code/work-repo -- gh codespace list
```

Notes: mappings live in `~/.config/gh-accounts/map.json` (0600; directories and usernames only). In a Codespace `GITHUB_TOKEN` is injected and always wins, so `list`, `current` and `map` work while `switch`/`add`/`remove` are refused with an explanation. `run` refuses to run if the injected token belongs to a different account than the mapping.
