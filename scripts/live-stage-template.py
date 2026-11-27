#!/usr/bin/env python3
"""Install tested, disabled live modules only. Does not start or reload services."""
import argparse
import base64
import hashlib
import json
import os
import pwd
import shutil
import subprocess
import sys
import tempfile
import zlib
from pathlib import Path

PAYLOAD='PAYLOAD_PLACEHOLDER'
PACKAGE_HASH='PACKAGE_HASH_PLACEHOLDER'
BASE=Path('/opt/index-options-mentor')
JOURNAL=BASE/'journal/store.py'
SERVICES=['index-options-mentor.service','index-options-journal.service']


def active():
    states={name:subprocess.check_output(['systemctl','show',name,'--property=ActiveState','--value'],text=True).strip()
            for name in SERVICES}
    if any(s!='active' for s in states.values()):
        raise RuntimeError('Existing app and journal services must both be active. No changes made.')
    return states


def no_symlink(path):
    for candidate in [path,*path.parents]:
        if candidate.is_symlink(): raise RuntimeError('Refusing a symlink in installation path: '+str(candidate))


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--verify-only',action='store_true')
    parser.add_argument('--journal-store',type=Path,help='Used only with --verify-only')
    args=parser.parse_args()
    if sys.version_info < (3,12): raise RuntimeError('Python 3.12 or newer is required.')
    if args.journal_store and not args.verify_only: raise RuntimeError('Custom journal source requires --verify-only.')
    if not args.verify_only and os.geteuid()!=0: raise RuntimeError('Run the installer using sudo python3.')
    source=(args.journal_store or JOURNAL).resolve(strict=True)
    if not source.is_file(): raise RuntimeError('Installed journal/store.py was not found.')
    raw=zlib.decompress(base64.b64decode(PAYLOAD,validate=True))
    if hashlib.sha256(raw).hexdigest()!=PACKAGE_HASH: raise RuntimeError('Embedded package checksum mismatch.')
    package=json.loads(raw)
    if package.get('format')!=1: raise RuntimeError('Unsupported package format.')
    expected={f'aws/live/{n}' for n in ['orders.py','planner.py','execution.py','bridge.py','fyers_broker.py','README.md']}
    expected.update(f'tests/{n}' for n in ['live_orders_test.py','live_execution_test.py','live_bridge_test.py','lift_lot_limit.py'])
    if set(package['files'])!=expected or set(package['sha256'])!=expected:
        raise RuntimeError('Unexpected package contents.')
    for path,content in package['files'].items():
        if hashlib.sha256(content.encode()).hexdigest()!=package['sha256'][path]: raise RuntimeError('Source checksum mismatch.')
    if args.verify_only:
        before=None; user=None; stage_parent=None
    else:
        no_symlink(BASE/'live')
        user=pwd.getpwnam('mentor'); before=active()
        stage_parent=BASE/'live/releases'
        no_symlink(stage_parent)
        stage_parent.mkdir(parents=True,exist_ok=True,mode=0o750)
        for parent in [BASE/'live',stage_parent]: os.chown(parent,0,user.pw_gid); os.chmod(parent,0o750)
    with tempfile.TemporaryDirectory(prefix='.iom-live-stage-',dir=stage_parent) as temporary:
        stage=Path(temporary)
        for path,content in package['files'].items():
            file=stage/path; file.parent.mkdir(parents=True,exist_ok=True); file.write_text(content)
        copied=stage/'aws/journal/store.py'; copied.parent.mkdir(parents=True); shutil.copyfile(source,copied)
        manifest={'packageSha256':PACKAGE_HASH,'packageSource':package['source'],
                  'journalStoreSha256':hashlib.sha256(copied.read_bytes()).hexdigest(),
                  'tradingEnabled':False,'serviceInstalled':False,'credentialsRead':False}
        (stage/'installed.json').write_text(json.dumps(manifest,indent=2)+'\n')
        if user:
            for root,dirs,files in os.walk(stage):
                os.chown(root,0,user.pw_gid); os.chmod(root,0o750)
                for name in files:
                    os.chown(Path(root)/name,0,user.pw_gid); os.chmod(Path(root)/name,0o640)
        command=[sys.executable,'-I','-m','unittest','discover','-s','tests','-p','live_*test.py','-q']
        env={'PATH':'/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin','LANG':'C.UTF-8','PYTHONDONTWRITEBYTECODE':'1','TMPDIR':'/tmp'}
        if user:
            command=['sudo','-u','mentor','--','env','PYTHONDONTWRITEBYTECODE=1','PYTHONPATH=','TMPDIR=/tmp',*command]
        print('Running simulated-broker and journal tests in a disposable database...',flush=True)
        subprocess.run(command,cwd=stage,env=env,check=True,timeout=120)
        if args.verify_only:
            print('PASS: package verified; simulated tests passed; nothing installed.')
            return
        if active()!=before: raise RuntimeError('Existing service status changed. Release will not be selected.')
        destination=stage_parent/PACKAGE_HASH[:20]
        no_symlink(destination)
        if destination.exists():
            for path,content in package['files'].items():
                target=destination/path
                no_symlink(target)
                if not target.is_file() or target.read_text()!=content:
                    raise RuntimeError('Existing release differs. Refusing to overwrite it.')
            if (destination/'installed.json').read_text()!=(stage/'installed.json').read_text():
                raise RuntimeError('Existing release journal version differs. No files overwritten.')
        else:
            stage.rename(destination)
            # TemporaryDirectory cleanup now sees a missing path, which is safe.
        current=BASE/'live/current'
        if current.exists() or current.is_symlink():
            if not current.is_symlink() or current.resolve().parent!=stage_parent.resolve():
                raise RuntimeError('Existing current path is not a managed release. No switch made.')
        link=BASE/'live'/('.current-'+str(os.getpid()))
        try:
            link.symlink_to(destination.relative_to(BASE/'live'),target_is_directory=True)
            link.replace(current)
        finally:
            if link.is_symlink(): link.unlink()
        print(json.dumps({'ok':True,'stage':'INSTALLED_DISABLED','release':str(destination),
              'tradingEnabled':False,'tests':'PASS','existingServices':active(),
              'liveServiceStarted':False,'productionDatabaseModified':False}))
        print('Installed and tested. Real-money trading is OFF. Existing app, journal and daily timer are unchanged.')


if __name__=='__main__':
    try: main()
    except Exception as error:
        print('INSTALLATION STOPPED: '+str(error),file=sys.stderr)
        sys.exit(1)
