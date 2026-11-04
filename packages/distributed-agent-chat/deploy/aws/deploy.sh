#!/usr/bin/env bash
# Deploy the DAC PoC owner node to ONE t4g.micro in us-east-1. Every resource is tagged project=dac-poc; teardown.sh removes exactly those.
#   deploy.sh up       create everything (idempotent-ish: refuses if a tagged instance already exists)
#   deploy.sh status   show tagged instance + endpoint
# EXPECTED_AWS_ACCOUNT_ID must be set before `deploy.sh up` to the AWS account ID you expect to deploy to; `up` exits if it is unset or does not match the current account.
# Secrets live only in ~/.dac-poc/env (mode 0600) and in one SecureString SSM parameter; they are never printed or put on a command line.
set -euo pipefail
export AWS_DEFAULT_REGION=us-east-1 AWS_PAGER=""
REGION=us-east-1; TAG_K=project; TAG_V=dac-poc
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"; PKG="$(cd "$HERE/../.." && pwd)"
STATE="$HOME/.dac-poc"; ENVFILE="$STATE/env"; PARAM=/dac-poc/env; ROLE=dac-poc-ssm; SGNAME=dac-poc-sg
TAGS="Key=$TAG_K,Value=$TAG_V"
say() { printf '[deploy] %s\n' "$*"; }
find_instance() { aws ec2 describe-instances --region $REGION --filters "Name=tag:$TAG_K,Values=$TAG_V" "Name=instance-state-name,Values=pending,running,stopping,stopped" --query 'Reservations[].Instances[].InstanceId' --output text; }

status() {
  local id; id=$(find_instance)
  [ -n "$id" ] || { say "no running $TAG_K=$TAG_V instance"; return 0; }
  aws ec2 describe-instances --region $REGION --instance-ids $id --query 'Reservations[].Instances[].[InstanceId,InstanceType,State.Name,PublicIpAddress]' --output text
  [ -f "$STATE/endpoint" ] && say "endpoint: $(cat "$STATE/endpoint")"
}

up() {
  if [ -z "${EXPECTED_AWS_ACCOUNT_ID:-}" ]; then echo "EXPECTED_AWS_ACCOUNT_ID is not set; set it to the AWS account ID you expect to deploy to" >&2; exit 1; fi
  [ "$(aws sts get-caller-identity --query Account --output text)" = "$EXPECTED_AWS_ACCOUNT_ID" ] || { echo "unexpected AWS account" >&2; exit 1; }
  [ -z "$(find_instance)" ] || { echo "a $TAG_K=$TAG_V instance already exists; run teardown.sh first" >&2; exit 1; }
  local acct; acct=$(aws sts get-caller-identity --query Account --output text)

  # 1. secrets: three distinct random values, 0600, outside git, never printed
  mkdir -p "$STATE" && chmod 700 "$STATE"
  if [ ! -s "$ENVFILE" ]; then
    ( umask 077; printf 'CHAT_TOKEN=%s\nPI_TOKEN=%s\nCLAUDE_TOKEN=%s\n' "$(openssl rand -hex 24)" "$(openssl rand -hex 24)" "$(openssl rand -hex 24)" > "$ENVFILE" )
  fi
  chmod 600 "$ENVFILE"; say "secrets file ready at $ENVFILE (0600)"

  # 2. app + secrets are installed over SSM by install-app.sh (also what Terraform calls)

  # 3. one narrowly scoped role + instance profile (SSM agent + read ONE parameter)
  local tmp; tmp=$(mktemp -d "$STATE/tmp.XXXXXX")
  cat > "$tmp/trust.json" <<JSON
{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":{"Service":"ec2.amazonaws.com"},"Action":"sts:AssumeRole"}]}
JSON
  cat > "$tmp/policy.json" <<JSON
{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Action":"ssm:GetParameter","Resource":"arn:aws:ssm:$REGION:$acct:parameter$PARAM"}]}
JSON
  aws iam create-role --role-name $ROLE --assume-role-policy-document "file://$tmp/trust.json" --tags $TAGS --description "dac-poc: SSM agent + read one parameter" >/dev/null
  aws iam attach-role-policy --role-name $ROLE --policy-arn arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore
  aws iam put-role-policy --role-name $ROLE --policy-name read-dac-poc-env --policy-document "file://$tmp/policy.json"
  aws iam create-instance-profile --instance-profile-name $ROLE --tags $TAGS >/dev/null
  aws iam add-role-to-instance-profile --instance-profile-name $ROLE --role-name $ROLE
  say "IAM role + instance profile $ROLE created"

  # 4. secrets -> one SecureString parameter (value read from a 0600 file, not from the command line)
  python3 - "$ENVFILE" "$tmp/param.json" "$PARAM" <<'PY'
import json, sys
env, out, name = sys.argv[1:]
json.dump({"Name": name, "Type": "SecureString", "Value": open(env).read(), "Tags": [{"Key": "project", "Value": "dac-poc"}]}, open(out, "w"))
PY
  chmod 600 "$tmp/param.json"; aws ssm put-parameter --cli-input-json "file://$tmp/param.json" >/dev/null; rm -f "$tmp/param.json"
  say "SecureString parameter $PARAM stored"

  # 5. security group: ONLY tcp/443 (no SSH, no 80)
  local vpc sg ami id
  vpc=$(aws ec2 describe-vpcs --filters Name=isDefault,Values=true --query 'Vpcs[0].VpcId' --output text)
  sg=$(aws ec2 create-security-group --group-name $SGNAME --description "dac-poc chat 443 only" --vpc-id "$vpc" --tag-specifications "ResourceType=security-group,Tags=[{Key=$TAG_K,Value=$TAG_V}]" --query GroupId --output text)
  aws ec2 authorize-security-group-ingress --group-id "$sg" --protocol tcp --port 443 --cidr 0.0.0.0/0 >/dev/null
  say "security group $sg: ingress tcp/443 only"

  # 6. the instance (t4g.micro, 8 GB gp3, IMDSv2 only, public IPv4 auto-assigned, NO Elastic IP)
  ami=$(aws ssm get-parameter --name /aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-arm64 --query Parameter.Value --output text)
  for attempt in 1 2 3 4 5 6; do   # IAM instance profiles take a few seconds to become usable
    if id=$(aws ec2 run-instances --image-id "$ami" --instance-type t4g.micro --count 1 --security-group-ids "$sg" \
        --iam-instance-profile Name=$ROLE --metadata-options HttpTokens=required,HttpEndpoint=enabled \
        --block-device-mappings 'DeviceName=/dev/xvda,Ebs={VolumeSize=8,VolumeType=gp3,DeleteOnTermination=true}' \
        --user-data "file://$HERE/bootstrap.sh" --instance-initiated-shutdown-behavior terminate \
        --tag-specifications "ResourceType=instance,Tags=[{Key=$TAG_K,Value=$TAG_V},{Key=Name,Value=dac-poc-node}]" \
                             "ResourceType=volume,Tags=[{Key=$TAG_K,Value=$TAG_V}]" \
                             "ResourceType=network-interface,Tags=[{Key=$TAG_K,Value=$TAG_V}]" \
        --query 'Instances[0].InstanceId' --output text 2>"$tmp/err"); then break; fi
    grep -q -i 'iam instance profile' "$tmp/err" && { sleep 8; continue; }; cat "$tmp/err" >&2; exit 1
  done
  [ -n "${id:-}" ] || { echo "run-instances failed" >&2; exit 1; }
  say "instance $id launching"
  aws ec2 wait instance-running --instance-ids "$id"
  local ip; ip=$(aws ec2 describe-instances --instance-ids "$id" --query 'Reservations[0].Instances[0].PublicIpAddress' --output text)
  local host="${ip//./-}.sslip.io"
  say "running, public IPv4 $ip -> $host"

  "$HERE/install-app.sh" "$id" "$ip"
  rm -rf "$tmp"
}
case "${1:-}" in up) up;; status) status;; *) echo "usage: deploy.sh up|status" >&2; exit 2;; esac
