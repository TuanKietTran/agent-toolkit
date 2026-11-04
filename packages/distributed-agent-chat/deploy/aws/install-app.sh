#!/usr/bin/env bash
# Install (or update) the DAC app on a dac-poc instance over SSM Run Command, then wait for HTTPS. Used by deploy.sh and by Terraform.
#   install-app.sh <instance-id> <public-ipv4>
# The instance must already have the dac-poc-ssm instance profile and the /dac-poc/env SecureString parameter.
# Secrets are never passed here: the instance reads them from the parameter itself.
set -euo pipefail
export AWS_DEFAULT_REGION=us-east-1 AWS_PAGER=""
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"; PKG="$(cd "$HERE/../.." && pwd)"
STATE="$HOME/.dac-poc"; PARAM=/dac-poc/env
say() { printf '[install] %s\n' "$*"; }
id="${1:?instance id}"; ip="${2:?public ipv4}"; host="${ip//./-}.sslip.io"
mkdir -p "$STATE" && chmod 700 "$STATE"; tmp=$(mktemp -d "$STATE/tmp.XXXXXX")
# 1. build the two bundles (no secrets inside)
( cd "$PKG" && npm run --silent build:node ) >/dev/null
bundle=$(mktemp "$STATE/bundle.XXXXXX"); tar -czf "$bundle" -C "$PKG/dist" node-server.mjs agent-cli.mjs
say "bundle $(wc -c < "$bundle") bytes"

# 2. wait for SSM, then ship app + secrets (secrets are fetched ON the instance from the parameter)
say "waiting for SSM agent..."
for i in $(seq 1 60); do
  [ "$(aws ssm describe-instance-information --filters Key=InstanceIds,Values="$id" --query 'InstanceInformationList[0].PingStatus' --output text 2>/dev/null)" = "Online" ] && break; sleep 5
done
python3 - "$bundle" "$tmp/cmd.json" "$host" "$PARAM" <<'PY'
import base64, json, sys
bundle, out, host, param = sys.argv[1:]
b64 = base64.b64encode(open(bundle, "rb").read()).decode()
script = f'''set -euo pipefail
for i in $(seq 1 120); do [ -f /var/lib/dac/bootstrap.done ] && break; sleep 5; done
[ -f /var/lib/dac/bootstrap.done ] || {{ echo "bootstrap not finished"; exit 1; }}
echo {b64} | base64 -d | tar -xzf - -C /opt/dac
chmod -R a+rX /opt/dac
umask 077
aws ssm get-parameter --region us-east-1 --name {param} --with-decryption --query Parameter.Value --output text > /etc/dac/all.env
{{ cat /etc/dac/all.env; printf 'PORT=18890\\nHOST=127.0.0.1\\nDATA_DIR=/var/lib/dac/rooms\\nNODE_NAME=aws\\n'; }} > /etc/dac/server.env
printf 'AGENT_TOKEN=%s\\nAGENT_MODE=mock\\nAGENT_ID=pi\\nWORKER_ID=pi-aws\\nROOM=demo\\nCHAT_URL=http://127.0.0.1:18890\\nAGENT_DATA_DIR=/var/lib/dac/agent\\nAGENT_CWD=/var/lib/dac\\n' "$(grep '^PI_TOKEN=' /etc/dac/all.env | cut -d= -f2-)" > /etc/dac/pi.env
rm -f /etc/dac/all.env
chown root:root /etc/dac/server.env /etc/dac/pi.env; chmod 600 /etc/dac/server.env /etc/dac/pi.env
mkdir -p /var/lib/dac/rooms /var/lib/dac/agent; chown -R dac:dac /var/lib/dac; chown -R caddy:caddy /var/lib/caddy
printf '{host} {{\\n  request_body {{\\n    max_size 32KB\\n  }}\\n  reverse_proxy 127.0.0.1:18890\\n}}\\n' > /etc/caddy/Caddyfile
chmod 644 /etc/caddy/Caddyfile
systemctl enable --now dac-node dac-agent-pi caddy-dac
sleep 3; systemctl is-active dac-node dac-agent-pi caddy-dac
'''
json.dump({"commands": [script]}, open(out, "w"))
PY
chmod 600 "$tmp/cmd.json"
cid=$(aws ssm send-command --instance-ids "$id" --document-name AWS-RunShellScript --parameters "file://$tmp/cmd.json" --comment "dac-poc install" --query Command.CommandId --output text)
say "install command $cid sent; waiting..."
st=InProgress
for i in $(seq 1 90); do
  st=$(aws ssm get-command-invocation --command-id "$cid" --instance-id "$id" --query Status --output text 2>/dev/null || echo Pending)
  case "$st" in Success|Failed|Cancelled|TimedOut) break;; esac; sleep 5
done
say "install status: $st"; aws ssm get-command-invocation --command-id "$cid" --instance-id "$id" --query '[StandardOutputContent,StandardErrorContent]' --output text | tail -8
rm -rf "$tmp" "$bundle"
[ "$st" = Success ] || { echo "install failed; run teardown.sh" >&2; exit 1; }
echo "https://$host" > "$STATE/endpoint"

# 3. wait for the TLS certificate and a healthy node
say "waiting for https://$host/healthz (Let's Encrypt via Caddy)..."
for i in $(seq 1 60); do curl -fsS --max-time 8 "https://$host/healthz" 2>/dev/null && { echo; break; }; sleep 5; done
say "endpoint: https://$host   (instance $id)"
