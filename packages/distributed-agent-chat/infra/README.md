# Fleet runbooks and local verification

The local OrbStack fleet was started and deployed with explicit user authorization. Two actual celld v0.6.2 nodes passed signed peer probes and shared-room/two-mock-agent HTTP checks on ports **18877 / 18878**; see `BUILD-REPORT.md` for exact evidence and limits. The stack is left running. No hard-failure takeover was tested. The exe.dev instructions below remain unexecuted by this infra task. No kube manifests are supplied.

## Upstream references and pinned commands

- [celld v0.6.2 README](https://github.com/denoland/celld/blob/v0.6.2/README.md), [operator docs](https://github.com/denoland/celld/blob/v0.6.2/docs/README.md), [counter example](https://github.com/denoland/celld/blob/v0.6.2/examples/counter/wrangler.jsonc).
- [Workers](https://github.com/denoland/celld/blob/v0.6.2/docs/services/workers.md), [Durable Objects](https://github.com/denoland/celld/blob/v0.6.2/docs/services/durable-objects.md), [compatibility](https://github.com/denoland/celld/blob/v0.6.2/docs/cloudflare-compat.md), [guarantees](https://github.com/denoland/celld/blob/v0.6.2/docs/guarantees.md), [security](https://github.com/denoland/celld/blob/v0.6.2/docs/security.md), [limitations](https://github.com/denoland/celld/blob/v0.6.2/docs/limitations.md).
- [release workflow](https://github.com/denoland/celld/blob/v0.6.2/.github/workflows/release.yml) publishes both `v0.6.2` and `0.6.2` image tags; [Dockerfile](https://github.com/denoland/celld/blob/v0.6.2/Dockerfile) installs `/usr/local/bin/celld`.

Actual documented daemon flags used here:

```sh
celld --bucket s3://BUCKET \
  --endpoint https://S3-ENDPOINT --region REGION \
  --listen 0.0.0.0:8080 \
  --internal-listen PRIVATE-IP:8081 --advertise PRIVATE-IP:8081
```

`CELLD_WATCH` selects the persistent node-local work directory. Omit `--endpoint` for AWS S3; set region appropriately. Bucket credentials come from the standard AWS env/credential chain, never from URL parameters. Nodes sharing a bucket form a fleet; each node must have its **own** work directory and advertised private address. Never share SQLite directories, expose port 8081 or use `--unsafe-public-advertise`.

`celld deploy PROJECT --bucket ... --endpoint ... --region ...` requires esbuild on PATH. Fleet nodes poll the committed deployment pointer (default 30 seconds). `celld deploy` **does not load `.dev.vars` or `.env`**. Our opt-in helper bundles the Worker and writes a mode-0600, ignored `.deploy/app/wrangler.json` containing the three token `vars`, deploys that directory, and removes the generated config. Tokens necessarily exist in the deployment objects in the bucket; bucket readers are fleet administrators. There is no fake runtime env-secret binding assumed here. Mount/encrypt disks and tightly restrict bucket access. `celld dev` is a separate, single-node local object-store mode; it is not evidence of a fleet.

## Local OrbStack / Docker Compose

Pinned versions: celld `v0.6.2`, MinIO `RELEASE.2025-04-22T22-12-26Z`, mc `RELEASE.2025-04-16T18-13-26Z`, source-build Go `1.24.2-bookworm`, tools Node `22.15.1-bookworm-slim`. Compose file is `infra/compose.yaml`. The celld image pulled successfully (observed repository digest `sha256:b85983dcf410bcf710bbc30f400d8654123cb2b541ca4d84d7e299009a6ee97a`). Docker Hub/Quay MinIO pulls were denied, so `infra/minio.Dockerfile` builds the **actual unpatched upstream release sources** from pinned codeload archive URLs, without git commands. These are local source-built images, not inaccessible registry images or simulated storage. Source release tags and base image versions are pinned; source archives are not checksum-pinned. Initial source/dependency download and compilation need internet access and took about 84 seconds in the verified environment.

MinIO is **local testing only**. Upstream says community MinIO passes the storage test but is not production-qualified, and explicitly warns against `RELEASE.2025-09-06T17-38-46Z`. This stack intentionally uses an earlier release. Do not generalize local MinIO success into production storage qualification.

1. Run `node --import tsx scripts/init-local-env.ts` to exclusively create an ignored `.env` with random secrets and mode 0600 (refuses to overwrite existing credentials). Never print its contents. Use `.env` only for Compose; `npm run worker` reads exported environment, not dotenv files.
2. After explicitly approving local stack startup, from the project root:

   ```sh
   docker compose --env-file .env -f infra/compose.yaml up -d --build minio bucket-init node-a node-b
   ```

   This starts two real Linux celld processes with separate `bucket`, `node-a` and `node-b` volumes. MinIO is attached solely to the internal `fleet` network. Both nodes also join a separate bridge `ingress` network, because OrbStack suppresses host port publication for internal-only networks. Only Worker listeners map to host loopback: A `127.0.0.1:18877`, B `127.0.0.1:18878` (override with `CHAT_PORT_A` / `CHAT_PORT_B`; port 8787 is reserved for the Pi bridge). MinIO API/console and celld internal listeners have **no host mappings**. No LLM credential or agent runs in these celld containers.
3. After separately approving deployment to this local bucket:

   ```sh
   CONFIRM_FLEET_DEPLOY=YES docker compose --env-file .env -f infra/compose.yaml run --rm --build tools
   ```

   The tools image includes Node, esbuild and the pinned actual celld binary; it deploys directly to MinIO over the private network. Without the exact confirmation env it exits without deployment. Wait for both nodes to adopt the bundle before testing.
4. Open A's browser UI. To start the two containerized mock workers after building/deploying the tools image:

   ```sh
   docker compose --env-file .env -f infra/compose.yaml --profile mock up -d mock-pi mock-claude
   CONFIRM_FLEET_TEST=YES node --env-file=.env --import tsx scripts/verify-fleet.ts
   ```

   These explicitly labeled MOCK Node workers run in separate containers, sharing only their respective celld node's network namespace, so each connects to its own node's loopback port 8080. They use the same `fleet-verify` room by default (`FLEET_TEST_ROOM` overrides it). Only the matching agent token enters each worker. Verification sends synthetic prompts through both host ingress ports, checks identical shared history, observes text before completion, checks sequenced events, idempotent send, same-session follow-up, cancellation fencing and no automatic ping-pong. Sanitized evidence is saved to ignored `.deploy/fleet-verification.json`. The test does not stop the workers or the stack. It does not test hard-failure ownership takeover.

   Alternatively run host workers with `CHAT_URL=http://127.0.0.1:18877` / `:18878` and securely exported matching tokens. For real agents use a different room and preserve provider-local state; do not collide with the mock room's pinned sessions.

Operator diagnostics (no token values in command arguments):

```sh
docker compose --env-file .env -f infra/compose.yaml run --rm tools celld diagnose --read-only \
  --bucket s3://session-chat --endpoint http://minio:9000 --region us-east-1
docker compose --env-file .env -f infra/compose.yaml run --rm tools celld cell list \
  --bucket s3://session-chat --endpoint http://minio:9000 --region us-east-1
```

Run diagnostics in the tools container: celld's diagnose command performs a listener bind check, so running it inside a serving node without an alternate port conflicts with that node's port 8080. `--read-only` skips its bucket write/delete probe. The verified output found two live compatible peers and two expired leases left by the ingress-network container recreation; expired leases were explicitly skipped.

Do not use unfiltered `docker compose config` or `docker inspect` in shared logs: they can display resolved secrets. Do not run `down -v` unless intentionally destroying all history and fleet state. Ordinary container restarts preserve the separate volumes.

### Fleet acceptance checklist (parent/operator must execute)

Record versions and actual results without tokens or prompts containing secrets.

- Diagnostics identify **two live reachable compatible peers**. Check both node logs for storage probe failures; stop if the storage contract is rejected.
- A user send on node A is visible with identical run ID/status/text/session ID from node B. Send to Pi and Claude explicitly and observe multiple text updates before completion. Mock records must say MOCK.
- Refresh/reconnect both UIs; verify transcript/history and no unrequested agent turn. Resend a transport-failed user send using the same ID and confirm no duplicate.
- Restart each external mock worker with the same stable ID; the next explicitly requested turn must report the same session ID and resumed state. Cancel a long turn and verify output stops and no automatic retry occurs.
- Restart the **non-owning** celld node, then the owner after a completed turn, preserving all volumes; reconnect through the surviving Worker listener and verify durable history. Use diagnostics / cell state to establish which node owned the room. A UI reading both ingress ports alone does not prove replication or failover.
- For an explicit hard-failure test, terminate the owner, wait for celld's lease recovery, and verify the room is restored on the other node. An in-flight agent turn may correctly become an error and must not be automatically re-executed. Record whether ownership transfer, bucket persistence and peer replication actually succeeded; do not infer them from workerd tests.

## Two exe.dev VMs (explicit opt-in, not provisioned)

Upstream: [standalone VMs](https://exe.dev/docs/standalone-vms), [cross-VM networking](https://exe.dev/docs/faq/cross-vm-networking), [HTTP proxy](https://exe.dev/docs/proxy). exe.dev does **not** give arbitrary VMs a private cross-VM network. Public `*.exe.xyz` ingress is not a celld peer network.

### 1. Provision only after approval

The optional script makes **two billable standalone sandboxes**, not a deployment:

```sh
CONFIRM_EXE_CREATE=YES EXE_NODE_A=chat-a EXE_NODE_B=chat-b ./scripts/exe-create.sh
```

It uses documented `ssh exe.dev new --sandbox --name=...`. It has no credentials, SSH key upload, bucket creation, auto-install, sharing change or deletion logic. The operator must be logged in to exe.dev already. Confirm both VMs with the exe.dev control plane; connect as `ssh chat-a.exe.xyz` and `ssh chat-b.exe.xyz`. If the second create fails, the first may remain billable; the script does not attempt destructive cleanup.

### 2. Private networking, storage, runtime

- Install/configure an encrypted private overlay (e.g. WireGuard or an operator-managed Tailscale network) on both VMs. Do not advertise `chat-a.exe.xyz:8081`. Establish private IPv4 addresses and permit **only the two peers** to reach TCP 8081 over the overlay. Confirm both directions are routable. Overlay enrollment/credentials are intentionally not automated.
- Use one already-created, qualified S3-compatible bucket reachable by both VMs (e.g. S3/R2/Tigris), with conditional writes and consistent reads. Keep MinIO local-only, not the production VM design. Give each node bucket access via a protected environment file or credential chain. Never proxy a bucket secret through the chat API.
- Install **celld v0.6.2** for Linux architecture from [release assets](https://github.com/denoland/celld/releases/tag/v0.6.2), verify upstream provenance through the GitHub attestation workflow if required, and install it on PATH. Install Node 22+, npm, and `npm ci` in this copied project on both VMs. No cosign/push is part of this project. Install Pi 0.84.4 on A / Claude Code 2.1.305 on B only if testing actual providers, authenticate them separately, and keep auth files private.
- Copy the project (excluding `.env`, `.dev.vars`, `.deploy`, `.agent-data`, `node_modules`, `.git` and local runtime data) to `$HOME/distributed-agent-chat` on each VM. Provision each worker's trusted workspace separately; do not copy local credentials. Keep persistent disk capacity for celld and provider session files.

Create a mode-0600 `$HOME/.config/session-chat/cell.env` on **each VM**, with actual values substituted (systemd EnvironmentFile syntax, absolute paths, no shell expansion):

```dotenv
CONFIRM_CELLD_RUN=YES
CELLD_BUCKET=s3://YOUR-SHARED-BUCKET
S3_ENDPOINT=https://YOUR-S3-ENDPOINT
AWS_REGION=YOUR-REGION
AWS_ACCESS_KEY_ID=YOUR-NODE-BUCKET-ACCESS-ID
AWS_SECRET_ACCESS_KEY=YOUR-NODE-BUCKET-SECRET
CELLD_PRIVATE_IP=THIS-VM-PRIVATE-OVERLAY-IP
CELLD_WATCH=/absolute/persistent/node-local/celld-state
```

A and B share the bucket, not the `CELLD_WATCH` volume. `scripts/run-celld.sh` validates its opt-in and version and runs the documented flags, binding only the internal listener to the private overlay IP. It does not install anything. If using temporary AWS credentials also set `AWS_SESSION_TOKEN` securely. Omit `S3_ENDPOINT` for AWS S3.

### 3. Deploy once, then start two nodes

On one trusted admin environment with celld v0.6.2, npm dependencies and esbuild on PATH, export bucket configuration plus `CHAT_TOKEN`, `PI_TOKEN`, `CLAUDE_TOKEN` from protected files (not command arguments):

```sh
CONFIRM_FLEET_DEPLOY=YES npm run fleet:deploy
```

This mutates the selected bucket. Verify `CELLD_BUCKET`/`S3_ENDPOINT` before confirming. The three secrets become Worker vars in the bucket deployment. Do not copy this admin environment into provider worker shells.

After approval to start services, install `infra/exe/chat-cell.service` into each user's systemd user unit directory, ensure that celld's binary directory matches the unit PATH, then:

```sh
systemctl --user daemon-reload
systemctl --user enable --now chat-cell.service
```

Use your VM's supported service supervisor if systemd user sessions are unavailable. Arrange service persistence across logout using the VM's supported mechanism; the template alone does not enable lingering. Both daemon processes should be healthy and diagnostics should report both peers before a distribution claim.

### 4. Connect UI and external workers

Keep the exe.dev HTTP proxy **private**. With explicit operator approval configure Worker routing only:

```sh
ssh exe.dev share port chat-a 8080
ssh exe.dev share port chat-b 8080
ssh exe.dev share set-private chat-a
ssh exe.dev share set-private chat-b
```

Visit the private HTTPS proxy while authenticated to exe.dev, then enter the chat token. Do not change either proxy to port 8081. Remote HTTP clients cannot assume the private proxy will accept a chat Bearer token as exe.dev login; colocated workers avoid this by using `CHAT_URL=http://127.0.0.1:8080` on their own VM. Alternatively, host workers can use an SSH local tunnel to the Worker port on either VM and connect via loopback. TLS/SSH/overlay transport and application Bearer authentication are separate layers.

For each worker, create protected `agent-pi.env` on A and `agent-claude.env` on B in `$HOME/.config/session-chat`, containing only that worker's needed settings/provider credentials, not bucket or user secrets:

```dotenv
CHAT_URL=http://127.0.0.1:8080
ROOM=vm-test-room
AGENT_ID=pi
AGENT_MODE=mock
WORKER_ID=pi-exe-a
AGENT_TOKEN=YOUR-PI-TOKEN
AGENT_CWD=/absolute/trusted/workspace
AGENT_DATA_DIR=/absolute/persistent/pi-sessions
```

For B use `AGENT_ID=claude`, `WORKER_ID=claude-exe-b`, its own token/cwd. Start with `mock`; mode is session-pinned, so change to actual `pi` / `claude` **in a new room** for live tests. Preserve Pi sessions and Claude's home directory for restart continuity. Install `infra/exe/chat-agent@.service` in the user unit directory and adjust PATH if npm or provider binaries are installed elsewhere. After approval, start `chat-agent@pi` on A and `chat-agent@claude` on B. No worker has access to the other agent token.

Run the fleet acceptance checklist with two independent ingress paths, plus an actual provider turn/resume/cancel test only after authorizing model usage. **Until these are executed, two-VM deployment, live provider operation and celld failover remain unverified.**
