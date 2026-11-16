#!/bin/bash
# New dedicated beta host only. Contains public configuration, never credentials.
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
apt-get -o Acquire::Retries=10 update -qq
apt-get -o Acquire::Retries=10 install -y --no-install-recommends ca-certificates curl python3-boto3 e2fsprogs

# Mount only the new stack's retained EBS volume, identified by its volume ID.
volume_id='@@DATA_VOLUME@@'
device=''
for attempt in $(seq 1 120); do
  for serial in /sys/block/nvme*n1/device/serial; do
    [ -f "$serial" ] || continue
    if [ "$(tr -d ' -' < "$serial")" = "${volume_id//-/}" ]; then
      device="/dev/$(basename "$(dirname "$(dirname "$serial")")")"
      break
    fi
  done
  [ -n "$device" ] && break
  sleep 2
done
[ -b "$device" ] || { echo 'Dedicated data volume not found'; exit 1; }
if ! blkid "$device" >/dev/null 2>&1; then mkfs.ext4 -L memcode-team-data "$device"; fi
mkdir -p /var/lib/memcode
uuid=$(blkid -s UUID -o value "$device")
grep -q "UUID=$uuid " /etc/fstab || printf 'UUID=%s /var/lib/memcode ext4 defaults,nofail 0 2\n' "$uuid" >> /etc/fstab
mountpoint -q /var/lib/memcode || mount /var/lib/memcode
chmod 711 /var/lib/memcode
id memcode >/dev/null 2>&1 || useradd --system --home-dir /var/lib/memcode/state --shell /usr/sbin/nologin memcode
id memcode-caddy >/dev/null 2>&1 || useradd --system --home-dir /var/lib/memcode/caddy --shell /usr/sbin/nologin memcode-caddy
install -d -m 700 -o memcode -g memcode /var/lib/memcode/state
install -d -m 700 -o memcode-caddy -g memcode-caddy /var/lib/memcode/caddy
install -d -m 755 /opt/memcode-relay /opt/memcode-runtime /etc/memcode-relay

curl --fail --location --retry 3 '@@NODE_URL@@' -o /tmp/memcode-node.tar.gz
echo '@@NODE_SHA256@@  /tmp/memcode-node.tar.gz' | sha256sum --check --status
tar -xzf /tmp/memcode-node.tar.gz -C /opt/memcode-runtime --strip-components=1
curl --fail --location --retry 3 '@@CADDY_URL@@' -o /tmp/memcode-caddy.tar.gz
echo '@@CADDY_SHA256@@  /tmp/memcode-caddy.tar.gz' | sha256sum --check --status
echo '@@CADDY_SHA512@@  /tmp/memcode-caddy.tar.gz' | sha512sum --check --status
tar -xzf /tmp/memcode-caddy.tar.gz -C /opt/memcode-runtime caddy
chmod 755 /opt/memcode-runtime/bin/node /opt/memcode-runtime/caddy
[ "$(/opt/memcode-runtime/bin/node --version)" = 'v@@NODE_VERSION@@' ]
/opt/memcode-runtime/caddy version | grep -q '^v@@CADDY_VERSION@@ '
rm /tmp/memcode-node.tar.gz /tmp/memcode-caddy.tar.gz

cat > /etc/memcode-relay/config.json <<'CONFIG'
{"region":"@@REGION@@","artifactBucket":"@@ARTIFACT_BUCKET@@","backupBucket":"@@BACKUP_BUCKET@@","publicURL":"https://@@HOSTNAME@@","nodeVersion":"@@NODE_VERSION@@","caddyVersion":"@@CADDY_VERSION@@"}
CONFIG
chmod 644 /etc/memcode-relay/config.json

# Restore only onto an empty, newly created state directory. A retained volume
# with any existing Team state always wins over a backup; never overwrite it.
python3 - <<'PY'
import boto3, json, pathlib, tarfile, tempfile
root=pathlib.Path('/var/lib/memcode')
if not any((root/'state').iterdir()):
  with open('/etc/memcode-relay/config.json') as file: config=json.load(file)
  client=boto3.client('s3',region_name=config['region'])
  entries=[]
  for page in client.get_paginator('list_objects_v2').paginate(Bucket=config['backupBucket'],Prefix='snapshots/'):
    entries.extend(item for item in page.get('Contents',[]) if item['Key'].endswith('.tar.gz'))
  if entries:
    latest=max(entries,key=lambda item:item['LastModified'])
    if latest['Size']>16*1024**3: raise RuntimeError('Backup exceeds dedicated state capacity')
    with tempfile.TemporaryFile() as archive:
      client.download_fileobj(config['backupBucket'],latest['Key'],archive)
      archive.seek(0)
      with tarfile.open(fileobj=archive,mode='r:gz') as data:
        members=data.getmembers()
        if len(members)>200000 or sum(member.size for member in members)>16*1024**3:
          raise RuntimeError('Expanded backup exceeds dedicated state capacity')
        for member in members:
          if member.name.split('/')[0] not in ('state','caddy') or member.issym() or member.islnk():
            raise RuntimeError('Unexpected path or link in private state backup')
        data.extractall(root,filter='data')
    print('Restored latest private team checkpoint onto empty data volume')
PY
chown -R memcode:memcode /var/lib/memcode/state
chown -R memcode-caddy:memcode-caddy /var/lib/memcode/caddy

cat > /etc/memcode-relay/Caddyfile <<'CADDY'
{
  admin off
  email support@memtrace.io
}
@@HOSTNAME@@ {
  encode zstd gzip
  header {
    Strict-Transport-Security "max-age=31536000"
    X-Content-Type-Options nosniff
    Referrer-Policy no-referrer
  }
  request_body {
    max_size 8MB
  }
  reverse_proxy 127.0.0.1:8787 {
    flush_interval -1
  }
}
CADDY

cat > /etc/systemd/system/memcode-relay.service <<'UNIT'
[Unit]
Description=MemCode authenticated beta team relay
After=network-online.target
Wants=network-online.target
RequiresMountsFor=/var/lib/memcode
ConditionPathExists=/opt/memcode-relay/relay.cjs
[Service]
Type=simple
User=memcode
Group=memcode
UMask=0077
WorkingDirectory=/opt/memcode-relay
Environment=NODE_ENV=production
ExecStart=/opt/memcode-runtime/bin/node /opt/memcode-relay/start.cjs
Restart=on-failure
RestartSec=3
TimeoutStopSec=30
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=/var/lib/memcode/state
ProtectKernelTunables=true
ProtectKernelModules=true
ProtectControlGroups=true
RestrictSUIDSGID=true
LockPersonality=true
CapabilityBoundingSet=
LimitNOFILE=8192
StandardOutput=journal
StandardError=journal
[Install]
WantedBy=multi-user.target
UNIT

cat > /etc/systemd/system/memcode-caddy.service <<'UNIT'
[Unit]
Description=HTTPS for the dedicated MemCode beta team relay
After=network-online.target memcode-relay.service
Wants=network-online.target
RequiresMountsFor=/var/lib/memcode
[Service]
Type=notify
User=memcode-caddy
Group=memcode-caddy
Environment=XDG_DATA_HOME=/var/lib/memcode/caddy
Environment=XDG_CONFIG_HOME=/var/lib/memcode/caddy
ExecStart=/opt/memcode-runtime/caddy run --config /etc/memcode-relay/Caddyfile --adapter caddyfile
Restart=on-failure
RestartSec=3
TimeoutStopSec=15
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=/var/lib/memcode/caddy
AmbientCapabilities=CAP_NET_BIND_SERVICE
CapabilityBoundingSet=CAP_NET_BIND_SERVICE
LimitNOFILE=8192
[Install]
WantedBy=multi-user.target
UNIT

# Daily quiesced backup: a bounded pause preserves a consistent fsynced journal.
# The trap restarts the relay even if tar or S3 upload fails. Credentials come
# from the instance role; no key material is embedded in files or command lines.
cat > /opt/memcode-relay/backup.sh <<'BACKUP'
#!/bin/bash
set -euo pipefail
exec 9>/run/memcode-relay-backup.lock
flock -n 9 || exit 0
systemctl stop memcode-relay
trap 'systemctl start memcode-relay; rm -f /tmp/memcode-state-backup.tar.gz' EXIT
tar -czf /tmp/memcode-state-backup.tar.gz --exclude=state/relay.lock --exclude=state/ready.private.json -C /var/lib/memcode state caddy
systemctl start memcode-relay
python3 - <<'PY'
import boto3, datetime, json
with open('/etc/memcode-relay/config.json') as file: config=json.load(file)
key='snapshots/'+datetime.datetime.now(datetime.timezone.utc).strftime('%Y/%m/%d/%H%M%S')+'.tar.gz'
boto3.client('s3',region_name=config['region']).upload_file('/tmp/memcode-state-backup.tar.gz',config['backupBucket'],key)
print('Encrypted private team-state backup completed')
PY
BACKUP
chmod 700 /opt/memcode-relay/backup.sh
cat > /etc/systemd/system/memcode-relay-backup.service <<'UNIT'
[Unit]
Description=Consistent private MemCode beta backup
[Service]
Type=oneshot
ExecStart=/opt/memcode-relay/backup.sh
TimeoutStartSec=300
UNIT
cat > /etc/systemd/system/memcode-relay-backup.timer <<'UNIT'
[Unit]
Description=Daily private MemCode beta backup
[Timer]
OnCalendar=*-*-* 03:15:00 UTC
RandomizedDelaySec=300
Persistent=true
[Install]
WantedBy=timers.target
UNIT

mkdir -p /etc/systemd/journald.conf.d
printf '[Journal]\nStorage=persistent\nSystemMaxUse=128M\nMaxRetentionSec=30day\n' > /etc/systemd/journald.conf.d/memcode.conf
systemctl restart systemd-journald
systemctl daemon-reload
systemctl enable memcode-relay memcode-caddy memcode-relay-backup.timer
systemctl start memcode-relay-backup.timer
echo 'Dedicated relay host prepared. Deploy the reviewed private bundle using Systems Manager before opening service discovery.'
