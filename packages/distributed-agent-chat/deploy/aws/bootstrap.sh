#!/bin/bash
# EC2 user-data for the dac-poc node (Amazon Linux 2023, arm64). Contains NO secrets and NO app code:
# it only installs pinned Node + Caddy and creates systemd units. deploy.sh then ships the app and secrets over SSM.
set -euo pipefail
exec > >(tee -a /var/log/dac-bootstrap.log) 2>&1
NODE_VER=v22.16.0
CADDY_VER=2.10.0
useradd -r -m -d /var/lib/dac -s /sbin/nologin dac || true
useradd -r -m -d /var/lib/caddy -s /sbin/nologin caddy || true
mkdir -p /opt/dac /opt/node /etc/dac /etc/caddy && chmod 750 /etc/dac
cd /tmp
curl -fsSLO "https://nodejs.org/dist/$NODE_VER/node-$NODE_VER-linux-arm64.tar.xz"
curl -fsSL "https://nodejs.org/dist/$NODE_VER/SHASUMS256.txt" | grep " node-$NODE_VER-linux-arm64.tar.xz\$" | sha256sum -c -
tar -xJf "node-$NODE_VER-linux-arm64.tar.xz" -C /opt/node --strip-components=1
curl -fsSLO "https://github.com/caddyserver/caddy/releases/download/v$CADDY_VER/caddy_${CADDY_VER}_linux_arm64.tar.gz"
curl -fsSL "https://github.com/caddyserver/caddy/releases/download/v$CADDY_VER/caddy_${CADDY_VER}_checksums.txt" | grep " caddy_${CADDY_VER}_linux_arm64.tar.gz\$" | sha512sum -c -
tar -xzf "caddy_${CADDY_VER}_linux_arm64.tar.gz" caddy && install -m 0755 caddy /usr/local/bin/caddy
rm -f /tmp/node-*.tar.xz /tmp/caddy*

cat > /etc/systemd/system/dac-node.service <<'UNIT'
[Unit]
Description=DAC PoC node (owner)
After=network-online.target
[Service]
User=dac
EnvironmentFile=/etc/dac/server.env
ExecStart=/opt/node/bin/node --disable-warning=ExperimentalWarning /opt/dac/node-server.mjs
Restart=always
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true
ReadWritePaths=/var/lib/dac
[Install]
WantedBy=multi-user.target
UNIT
cat > /etc/systemd/system/dac-agent-pi.service <<'UNIT'
[Unit]
Description=DAC PoC MOCK pi agent worker (no LLM)
After=dac-node.service
[Service]
User=dac
EnvironmentFile=/etc/dac/pi.env
ExecStart=/opt/node/bin/node /opt/dac/agent-cli.mjs
Restart=always
RestartSec=2
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true
ReadWritePaths=/var/lib/dac
[Install]
WantedBy=multi-user.target
UNIT
cat > /etc/systemd/system/caddy-dac.service <<'UNIT'
[Unit]
Description=Caddy TLS front for DAC (443 only)
After=network-online.target
[Service]
User=caddy
Environment=XDG_DATA_HOME=/var/lib/caddy XDG_CONFIG_HOME=/var/lib/caddy
ExecStart=/usr/local/bin/caddy run --config /etc/caddy/Caddyfile --adapter caddyfile
AmbientCapabilities=CAP_NET_BIND_SERVICE
NoNewPrivileges=true
Restart=always
[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload
touch /var/lib/dac/bootstrap.done
echo "bootstrap complete"
