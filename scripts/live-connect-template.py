#!/usr/bin/env python3
"""Install the shared-socket feed bridge and separate trading login. No real orders."""
import argparse
import base64
import hashlib
import json
import os
from pathlib import Path
import pwd
import re
import shutil
import subprocess
import sys
import tempfile
import time
import zlib

PAYLOAD = 'PAYLOAD_PLACEHOLDER'
DIGEST = 'HASH_PLACEHOLDER'
BASE = Path('/opt/index-options-mentor')
FEED = Path('/var/lib/index-options-mentor/live-feed')


def no_links(path):
    if any(p.is_symlink() for p in [path,*path.parents]): raise RuntimeError('Unsafe installation path; no changes applied.')


def active(name):
    return subprocess.check_output(['systemctl','show',name,'--property=ActiveState','--value'],text=True).strip()


def daemon_service(app):
    services = set()
    for entry in Path('/proc').glob('[0-9]*'):
        try:
            command = (entry/'cmdline').read_bytes().split(b'\0')
            args = [c.decode(errors='replace') for c in command if c]
            if not any(a == str(app/'fyersMarketDaemon.mjs') or
                       a in ('fyersMarketDaemon.mjs','./fyersMarketDaemon.mjs') and
                       (entry/'cwd').resolve() == app.resolve() for a in args): continue
            for line in (entry/'cgroup').read_text().splitlines():
                match = re.search(r'/system\.slice/(index-options-[A-Za-z0-9_.@-]+\.service)(?:/|$)', line)
                if match: services.add(match[1])
        except (OSError, ValueError): continue
    if len(services) != 1: raise RuntimeError('Could not identify the one running FYERS feed service. No app files were changed.')
    service = services.pop()
    if active(service) != 'active': raise RuntimeError('The existing FYERS feed service is not active. No app files were changed.')
    return service


def run_tests(stage, journal, user=None):
    copied = stage/'aws/journal/store.py'; copied.parent.mkdir(parents=True,exist_ok=True)
    shutil.copyfile(journal,copied)
    if user:
        for root, dirs, files in os.walk(stage):
            os.chown(root,0,user.pw_gid);os.chmod(root,0o750)
            for name in files:os.chown(Path(root)/name,0,user.pw_gid);os.chmod(Path(root)/name,0o640)
    prefix = ['sudo','-u','mentor','--'] if user else []
    env = {'PATH':os.environ.get('PATH','/usr/bin:/bin'),'LANG':'C.UTF-8','PYTHONDONTWRITEBYTECODE':'1'}
    subprocess.run(prefix+[sys.executable,'-I','-m','unittest','discover','-s','tests','-p','live_*test.py','-q'],cwd=stage,env=env,check=True,timeout=150)
    subprocess.run(prefix+['node','--test','tests/live-feed-publisher.test.mjs'],cwd=stage,env=env,check=True,timeout=30)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--verify-only',action='store_true')
    parser.add_argument('--journal-store',type=Path)
    args = parser.parse_args()
    if sys.version_info < (3,12):raise RuntimeError('Python 3.12 or later is required.')
    if not args.verify_only and (os.geteuid()!=0 or args.journal_store):raise RuntimeError('Use sudo python3 from the SSH terminal.')
    raw = zlib.decompress(base64.b64decode(PAYLOAD,validate=True))
    if hashlib.sha256(raw).hexdigest()!=DIGEST:raise RuntimeError('Package checksum failed.')
    package = json.loads(raw)
    if package.get('format')!=3:raise RuntimeError('Invalid package format.')
    for name in package['files']:
        path=Path(name)
        if path.is_absolute() or '..' in path.parts or not name.startswith(('aws/live/','src/engine/','tests/','package.json')):raise RuntimeError('Invalid package path.')
    journal=args.journal_store or BASE/'journal/store.py'
    with tempfile.TemporaryDirectory(prefix='iom-live-connect-') as temporary:
        stage=Path(temporary)
        for name,content in package['files'].items():
            file=stage/name;file.parent.mkdir(parents=True,exist_ok=True);file.write_text(content)
        user=None if args.verify_only else pwd.getpwnam('mentor')
        print('Testing shared feed, independent quote times, trailing exits, restart, replay and account login...',flush=True)
        run_tests(stage,journal,user)
        if args.verify_only:
            print('PASS: installation package tests; no services, credentials or production data changed.');return
        sys.path.insert(0,str(stage/'aws/live'))
        from feed_patch import patch
        from account_connect import secure_json
        app=BASE/'app'; daemon=app/'fyersMarketDaemon.mjs';publisher=app/'liveFeedPublisher.mjs'
        for p in (daemon,publisher,FEED,BASE/'live-connect/releases'):no_links(p)
        services=('index-options-mentor.service','index-options-journal.service','index-options-journal-daily.timer')
        before={name:active(name) for name in services}
        if any(value!='active' for value in before.values()):raise RuntimeError('Existing app, journal or backup timer is not active. No files changed.')
        # A feed restart is deferred while an existing paper position is open.
        state=secure_json('/var/lib/index-options-mentor/paper-state.json')
        if any(isinstance(state.get(s),dict) and state[s].get('status')=='OPEN' for s in ('core','scalp')):
            raise RuntimeError('An existing paper position is open. Its feed was left running and no files changed.')
        service=daemon_service(app)
        original=daemon.read_text();updated=patch(original)
        check=stage/'patched-daemon.mjs';check.write_text(updated)
        subprocess.run(['node','--check',str(check)],check=True,capture_output=True)
        release=BASE/'live-connect/releases'/DIGEST[:20]
        no_links(release);release.mkdir(parents=True,exist_ok=True,mode=0o750)
        for parent in (BASE/'live-connect',BASE/'live-connect/releases',release):os.chown(parent,0,user.pw_gid);os.chmod(parent,0o750)
        for name in package['files']:
            source=stage/name;target=release/name;no_links(target)
            if target.exists() and target.read_bytes()!=source.read_bytes():raise RuntimeError('Existing release differs. No app files changed.')
            target.parent.mkdir(parents=True,exist_ok=True);shutil.copyfile(source,target)
            os.chown(target,0,user.pw_gid);os.chmod(target,0o640)
        for root,dirs,files in os.walk(release):os.chown(root,0,user.pw_gid);os.chmod(root,0o750)
        FEED.mkdir(mode=0o700,parents=True,exist_ok=True);os.chown(FEED,user.pw_uid,user.pw_gid);os.chmod(FEED,0o700)
        backup=daemon.with_name('fyersMarketDaemon.mjs.pre-live-feed-'+hashlib.sha256(original.encode()).hexdigest()[:16])
        no_links(backup)
        if not backup.exists():shutil.copy2(daemon,backup)
        previous=publisher.read_bytes() if publisher.exists() else None
        previous_mode=publisher.stat().st_mode & 0o777 if publisher.exists() else None
        try:
            shutil.copyfile(stage/'aws/live/liveFeedPublisher.mjs',publisher);os.chown(publisher,0,user.pw_gid);os.chmod(publisher,0o640)
            # Replace the source atomically; never edit a running file incrementally.
            fd,temp=tempfile.mkstemp(prefix='.fyers-live-feed-',dir=app)
            try:
                os.fchmod(fd,daemon.stat().st_mode & 0o777);os.fchown(fd,daemon.stat().st_uid,daemon.stat().st_gid)
                with os.fdopen(fd,'w') as handle:handle.write(updated);handle.flush();os.fsync(handle.fileno())
                os.replace(temp,daemon)
            finally:
                if os.path.exists(temp):os.unlink(temp)
            restarted_at=time.time()*1000
            subprocess.run(['systemctl','restart',service],check=True)
            # This file is written only after this process's successful subscription ACK.
            fresh=False
            for attempt in range(40):
                if active(service)!='active':raise RuntimeError('The feed service did not stay active.')
                try:
                    packet=secure_json(FEED/'quotes.json')
                    if packet.get('connected') is True and packet.get('publishedAt',0) >= max(restarted_at,time.time()*1000-3000):
                        fresh=True;break
                except (OSError,ValueError):pass
                time.sleep(.25)
            if not fresh:raise RuntimeError('No fresh authenticated FYERS feed acknowledgement was observed.')
            if {name:active(name) for name in services}!=before:raise RuntimeError('An existing service changed state.')
            print(json.dumps({'ok':True,'sharedFyersSocketConnected':True,'paperDispatcherPreserved':True,
                'realMoneyEnabled':False,'ordersSent':0,'productionJournalTouched':False,
                'feedService':service,'tradingLoginCommand':'sudo python3 '+str(release/'aws/live/account_connect.py'),
                'brokerStopsVerified':False,'actualLiveExecutionHostReleased':False}))
            print('Shared feed connected. Paper credentials unchanged. Real-money trading is OFF.')
        except Exception:
            shutil.copy2(backup,daemon)
            if previous is None:
                if publisher.exists():publisher.unlink()
            else:publisher.write_bytes(previous);os.chown(publisher,0,user.pw_gid);os.chmod(publisher,previous_mode)
            subprocess.run(['systemctl','restart',service],check=False)
            raise RuntimeError('Feed setup did not pass and its app-file changes were rolled back. No orders were sent.')

if __name__=='__main__':
    try:main()
    except Exception as error:
        # SDK and credential payloads are never printed by this installer.
        reason=str(error) if isinstance(error,RuntimeError) else 'Installation stopped safely; no real orders were sent.'
        print('STOP: '+reason,file=sys.stderr);sys.exit(1)
