#!/usr/bin/env bash
set -euo pipefail
umask 077

if [ "$(id -u)" -ne 0 ]; then
  echo 'Run this installer with sudo.' >&2
  exit 1
fi

PACKAGE_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
TARGET=/opt/index-options-mentor/journal
DATA=/var/lib/index-options-mentor/journal
getent passwd mentor >/dev/null
command -v python3 >/dev/null
command -v nginx >/dev/null
python3 -c 'import sqlite3; assert sqlite3.sqlite_version_info >= (3,24,0)'

install -d -m 0750 -o root -g mentor "$TARGET"
install -d -m 0700 -o mentor -g mentor "$DATA" "$DATA/backups"
install -m 0640 -o root -g mentor "$PACKAGE_DIR/store.py" "$PACKAGE_DIR/service.py" "$TARGET/"

# Discover only the existing paper-bridge key and verify it against Netlify.
# Never print it or modify the monitor's environment.
python3 - <<'PY'
import glob
import hashlib
import hmac
import json
import os
import pathlib
import pwd
import re
import subprocess
import time
import urllib.request
import uuid

origin = 'https://optionsmentor.netlify.app'
keys = set(['AWS_PAPER_SYNC_SECRET', 'PAPER_SYNC_SECRET', 'PAPER_BRIDGE_SECRET',
            'PAPER_BRIDGE_HMAC_SECRET', 'PAPER_SYNC_HMAC_SECRET'])
source = pathlib.Path('/opt/index-options-mentor/app/paperBridgeAuth.mjs').read_text()
keys.update(re.findall(r'process\.env\.([A-Z_]*(?:PAPER|BRIDGE)[A-Z_]*(?:SECRET|KEY)[A-Z_]*)', source))
candidates = []
pid = subprocess.check_output(['systemctl','show','index-options-mentor.service','--property=MainPID','--value'],text=True).strip()
if pid.isdigit() and pid != '0':
    environ = pathlib.Path('/proc', pid, 'environ').read_bytes().decode().split('\0')
    for line in environ:
        key, _, value = line.partition('=')
        if key in keys:
            candidates.append(value)

files = set()
for pattern in ('/etc/index-options-mentor/*.env', '/etc/index-options-mentor/*.conf',
                '/etc/index-options-mentor/*secret*', '/etc/index-options-mentor/*.json',
                '/etc/index-options-mentor.env', '/etc/default/index-options-mentor',
                '/opt/index-options-mentor/app/.env', '/opt/index-options-mentor/.env',
                '/var/lib/index-options-mentor/*secret*', '/var/lib/index-options-mentor/*bridge*.json'):
    files.update(glob.glob(pattern))
# Absolute key-file paths used directly by the deployed bridge are also eligible.
files.update(re.findall(r"['\"](/(?:etc|var/lib)/index-options-mentor/[^'\"]*(?:secret|bridge)[^'\"]*)['\"]", source))
for name in sorted(files):
    file = pathlib.Path(name)
    if not file.is_file() or file.stat().st_size > 32768 or '.pre-' in name:
        continue
    text = file.read_text().strip()
    for key in keys:
        match = re.search(r'^\s*(?:export\s+)?' + re.escape(key) + r'\s*=\s*(.+?)\s*$', text, re.M)
        if match:
            candidates.append(match.group(1).strip().strip('\"\''))
    try:
        value = json.loads(text)
        if isinstance(value, dict):
            candidates.extend(v for k,v in value.items() if isinstance(v,str) and ('secret' in k.lower() or k in keys))
    except ValueError:
        if re.fullmatch(r'[A-Za-z0-9_+/=.-]{32,256}', text):
            candidates.append(text)

payload = b'{"action":"health"}'
path = '/api/journal-maintenance'
for secret in dict.fromkeys(candidates):
    if len(secret) < 32:
        continue
    stamp, nonce = str(int(time.time()*1000)), uuid.uuid4().hex
    canonical = '\n'.join((stamp,nonce,'POST',path,hashlib.sha256(payload).hexdigest()))
    signed = hmac.new(secret.encode(),canonical.encode(),hashlib.sha256).hexdigest()
    request = urllib.request.Request(origin+path,payload,headers={
        'Content-Type':'application/json','x-iom-time':stamp,'x-iom-nonce':nonce,'x-iom-signature':signed})
    try:
        with urllib.request.urlopen(request,timeout=60) as response:
            result=json.load(response)
        if not result.get('ok'):
            continue
    except Exception:
        continue
    file=pathlib.Path('/etc/index-options-journal.json')
    fd=os.open(file,os.O_WRONLY|os.O_CREAT|os.O_TRUNC,0o640)
    with os.fdopen(fd,'w') as stream:
        json.dump({'secret':secret,'netlify':origin},stream)
    os.chown(file,0,pwd.getpwnam('mentor').pw_gid)
    os.chmod(file,0o640)
    print('Verified existing journal export connection.')
    break
else:
    raise SystemExit('STOP: Could not verify the existing bridge key. Deploy the companion Netlify functions first. Production journal has not been switched.')
PY

cat > /etc/systemd/system/index-options-journal.service <<'UNIT'
[Unit]
Description=Index Options Mentor SQLite journal
After=network-online.target
Wants=network-online.target

[Service]
User=mentor
Group=mentor
WorkingDirectory=/opt/index-options-mentor/journal
ExecStart=/usr/bin/python3 /opt/index-options-mentor/journal/service.py serve
Restart=on-failure
RestartSec=5
UMask=0077
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=/var/lib/index-options-mentor/journal

[Install]
WantedBy=multi-user.target
UNIT

cat > /etc/systemd/system/index-options-journal-daily.service <<'UNIT'
[Unit]
Description=Back up SQLite journal and export pending records to Google Sheets
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
User=mentor
Group=mentor
WorkingDirectory=/opt/index-options-mentor/journal
ExecStart=/usr/bin/flock -n /var/lib/index-options-mentor/journal/daily.lock /usr/bin/python3 /opt/index-options-mentor/journal/service.py daily
TimeoutStartSec=4h
Restart=on-failure
RestartSec=300
UMask=0077
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=/var/lib/index-options-mentor/journal
UNIT

cat > /etc/systemd/system/index-options-journal-daily.timer <<'UNIT'
[Unit]
Description=Daily trade journal backup and Sheets export at 20:30 IST

[Timer]
OnCalendar=*-*-* 20:30:00 Asia/Kolkata
Persistent=true
AccuracySec=1min
Unit=index-options-journal-daily.service

[Install]
WantedBy=timers.target
UNIT

# Import and verify before serving any SQLite requests.
cd /tmp
sudo -u mentor /usr/bin/python3 "$TARGET/service.py" migrate
systemctl daemon-reload
systemctl enable --now index-options-journal.service

# Add the loopback route inside the existing API virtual host. Back up all edited files.
python3 - <<'PY'
import pathlib
import re
import shutil
import subprocess
import time

changed=[]
stamp=str(int(time.time()))
route='''    location = /journal/bridge {
        client_max_body_size 8m;
        proxy_pass http://127.0.0.1:9076;
        proxy_read_timeout 60s;
        proxy_set_header Host $host;
    }
'''
files={p.resolve() for directory in ('/etc/nginx/sites-enabled','/etc/nginx/conf.d')
       for p in pathlib.Path(directory).glob('*') if p.is_file()}
for file in sorted(files):
    source=file.read_text()
    if not re.search(r'\bserver_name\s+[^;]*\bapi\.optionsmentor\.in\b',source):
        continue
    if 'location = /journal/bridge' in source:
        continue
    updated=re.sub(r'(?m)^([ \t]*server_name\s+[^;]*\bapi\.optionsmentor\.in\b[^;]*;)',
                   lambda match: route+match.group(1), source)
    backup=file.with_name(file.name+'.pre-sqlite-'+stamp)
    shutil.copy2(file,backup)
    file.write_text(updated)
    changed.append((file,backup))
if not changed and not any('location = /journal/bridge' in p.read_text() for p in files):
    raise SystemExit('STOP: API nginx host was not found. Production journal remains on Sheets.')
try:
    subprocess.run(['nginx','-t'],check=True)
    subprocess.run(['systemctl','reload','nginx'],check=True)
except Exception:
    for file,backup in changed:
        shutil.copy2(backup,file)
    raise
PY

systemctl enable --now index-options-journal-daily.timer
systemctl start index-options-journal-daily.service
sudo -u mentor /usr/bin/python3 "$TARGET/service.py" health
systemctl list-timers index-options-journal-daily.timer --no-pager
echo 'SQLite installed, history imported, backup checked, daily timer enabled.'
echo 'Production cutover still requires JOURNAL_STORAGE=sqlite in Netlify and a successful journal write/read check.'
