#!/bin/sh
# Starts ONE already-provisioned node. No install, provisioning or deployment.
set -eu
[ "${CONFIRM_CELLD_RUN:-NO}" = YES ] || { printf '%s\n' 'Disabled: node startup requires CONFIRM_CELLD_RUN=YES.' >&2; exit 1; }
: "${CELLD_BUCKET:?set the shared s3:// bucket}"
: "${CELLD_PRIVATE_IP:?set this node private overlay IPv4}"
: "${CELLD_WATCH:?set a persistent node-local absolute state directory}"
case "$CELLD_PRIVATE_IP" in 10.*|192.168.*|172.1[6-9].*|172.2[0-9].*|172.3[01].*|100.*) ;; *) printf '%s\n' 'Private/overlay IP required, never use a public address.' >&2; exit 1;; esac
celld --version | grep -Eq '(^|[[:space:]])0\.6\.2([[:space:]]|$)' || { printf '%s\n' 'celld v0.6.2 required.' >&2; exit 1; }
set -- --bucket "$CELLD_BUCKET" --listen 0.0.0.0:8080 --internal-listen "$CELLD_PRIVATE_IP:8081" --advertise "$CELLD_PRIVATE_IP:8081"
if [ -n "${S3_ENDPOINT:-}" ]; then set -- "$@" --endpoint "$S3_ENDPOINT"; fi
if [ -n "${AWS_REGION:-}" ]; then set -- "$@" --region "$AWS_REGION"; fi
exec celld "$@"
