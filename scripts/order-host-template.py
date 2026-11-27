#!/usr/bin/env python3
"""Install the actual order host with broker sending DISABLED. Never sends orders."""
import argparse,base64,hashlib,hmac,json,os,pwd,re,shutil,sqlite3,subprocess,sys,tempfile,time,uuid,zlib
from pathlib import Path
import urllib.request
PAYLOAD='PAYLOAD_PLACEHOLDER'
DIGEST='HASH_PLACEHOLDER'
BASE=Path('/opt/index-options-mentor')
DATA=Path('/var/lib/index-options-mentor/order-host')
SERVICE='index-options-order-host.service'
TIMER='index-options-order-backup.timer'
NETLIFY='https://optionsmentor.netlify.app'
PUBLIC_API='https://api.optionsmentor.in'
UNIT_DIR=Path('/etc/systemd/system')
NGINX_DIRS=('/etc/nginx/sites-enabled','/etc/nginx/conf.d')
HOST_CONFIG=Path('/etc/index-options-order-host.json')

def run(args,**kw):return subprocess.run(args,check=True,**kw)
def no_links(path):
    if any(p.is_symlink() for p in [path,*path.parents]):raise RuntimeError('Unsafe installation path.')
def active(name):return subprocess.check_output(['systemctl','show',name,'--property=ActiveState','--value'],text=True).strip()
def states():
    names=['index-options-mentor.service','index-options-marketdata.service','index-options-journal.service','index-options-journal-daily.timer']
    result={n:active(n) for n in names}
    if any(v!='active' for v in result.values()):raise RuntimeError('An existing app/feed/journal/backup service is not active. No installation changes made.')
    return result

def status_request(base,path,secret,owner):
    body=b'{}';stamp=str(int(time.time()));nonce=uuid.uuid4().hex
    message='\n'.join(['v1',stamp,nonce,owner,'POST',path,hashlib.sha256(body).hexdigest()])
    sig=hmac.new(secret.encode(),message.encode(),hashlib.sha256).hexdigest()
    req=urllib.request.Request(base+path,body,headers={'content-type':'application/json','x-iom-time':stamp,'x-iom-nonce':nonce,'x-iom-owner':owner,'x-iom-signature':sig})
    class NoRedirect(urllib.request.HTTPRedirectHandler):
        def redirect_request(self,*a,**k):return None
    with urllib.request.build_opener(urllib.request.ProxyHandler({}),NoRedirect()).open(req,timeout=30) as response:return json.load(response)

def main():
    parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('--verify-only',action='store_true');parser.add_argument('--journal-store',type=Path)
    parser.add_argument('--site-is-private',action='store_true',help='The website has a Netlify private lock: check the public server address, then check the website in the app.')
    args=parser.parse_args()
    if sys.version_info<(3,12):raise RuntimeError('Python 3.12 or later required.')
    if not args.verify_only and (os.geteuid()!=0 or args.journal_store):raise RuntimeError('Use sudo python3 from SSH.')
    raw=zlib.decompress(base64.b64decode(PAYLOAD,validate=True))
    if hashlib.sha256(raw).hexdigest()!=DIGEST:raise RuntimeError('Package checksum failed.')
    package=json.loads(raw)
    if package.get('format')!=4:raise RuntimeError('Invalid package format.')
    for name in package['files']:
        p=Path(name)
        if p.is_absolute() or '..' in p.parts or not name.startswith(('aws/live/','src/engine/','server/','tests/','netlify/functions/','package.json')):raise RuntimeError('Invalid source path.')
    with tempfile.TemporaryDirectory(prefix='iom-order-host-') as temporary:
        stage=Path(temporary)
        for name,value in package['files'].items():
            p=stage/name;p.parent.mkdir(parents=True,exist_ok=True);p.write_text(value)
        journal=args.journal_store or BASE/'journal/store.py'
        (stage/'aws/journal').mkdir(parents=True,exist_ok=True);shutil.copyfile(journal,stage/'aws/journal/store.py')
        user=None if args.verify_only else pwd.getpwnam('mentor')
        if user:
            for root,dirs,files in os.walk(stage):
                os.chown(root,0,user.pw_gid);os.chmod(root,0o750)
                for name in files:os.chown(Path(root)/name,0,user.pw_gid);os.chmod(Path(root)/name,0o640)
        prefix=['sudo','-u','mentor','--'] if user else []
        env={'PATH':os.environ.get('PATH','/usr/bin:/bin'),'LANG':'C.UTF-8','PYTHONDONTWRITEBYTECODE':'1'}
        print('Testing owned entries, partial fills, broker stops, shared strategies, restart, exits, replay and authentication...',flush=True)
        run(prefix+[sys.executable,'-I','-m','unittest','discover','-s','tests','-p','live_*test.py','-q'],cwd=stage,env=env,timeout=180)
        run(prefix+['node','--test','tests/order-host-auth.test.mjs','tests/entry-signals.test.mjs','tests/live-feed-publisher.test.mjs'],cwd=stage,env=env,timeout=60)
        if args.verify_only:print('PASS: actual-host package; no service installed, no orders or production journal writes.');return
        sys.path.insert(0,str(stage/'aws/live'))
        from account_connect import secure_json,pinned_proof,verify_owner,request
        before=states();config_file=HOST_CONFIG;no_links(config_file);no_links(DATA)
        if config_file.exists() and secure_json(config_file).get('realMoneyEnabled') is not False:raise RuntimeError('An enabled order host exists. It was not changed.')
        database=DATA/'orders.sqlite3'
        if database.exists():
            no_links(database)
            with sqlite3.connect('file:'+str(database)+'?mode=ro',uri=True) as db:
                if db.execute("SELECT 1 FROM sqlite_master WHERE name='live_intents'").fetchone():
                    db.row_factory=sqlite3.Row;rows=list(db.execute('SELECT * FROM live_intents'))
                    unresolved=any(r['state'] not in ('FILLED','BLOCKED','CANCELLED','REJECTED','EXPIRED') for r in rows)
                    outside={}
                    if db.execute("SELECT 1 FROM sqlite_master WHERE name='live_external_closes'").fetchone():
                        outside={r['entry_id']:r['quantity'] for r in db.execute('SELECT * FROM live_external_closes')}
                    exposed=any(not r['parent_id'] and r['filled_qty']>outside.get(r['id'],0)+sum(c['filled_qty'] for c in rows if c['parent_id']==r['id']) for r in rows)
                    if unresolved or exposed:raise RuntimeError('Existing broker intents require review; no service changes made.')
        account=secure_json('/etc/index-options-live-account.json');secret=secure_json('/etc/index-options-journal.json')['secret']
        owner=pinned_proof(secure_json('/var/lib/index-options-mentor/paper-owner.json'))
        if account.get('ownerProof')!=owner:raise RuntimeError('Trading account owner does not match the paper account.')
        verify_owner(request('profile',app=account['appId'],token=account['accessToken']),owner,secret)
        release=BASE/'order-host/releases'/DIGEST[:20];no_links(release);release.mkdir(parents=True,exist_ok=True,mode=0o750)
        for p in (BASE/'order-host',BASE/'order-host/releases',release):os.chown(p,0,user.pw_gid);os.chmod(p,0o750)
        for name,value in package['files'].items():
            p=release/name;no_links(p)
            if p.exists() and p.read_text()!=value:raise RuntimeError('Existing release differs; refusing overwrite.')
            p.parent.mkdir(parents=True,exist_ok=True);p.write_text(value);os.chown(p,0,user.pw_gid);os.chmod(p,0o640)
        for root,dirs,files in os.walk(release):os.chown(root,0,user.pw_gid);os.chmod(root,0o750)
        DATA.mkdir(parents=True,exist_ok=True,mode=0o700);os.chown(DATA,user.pw_uid,user.pw_gid);os.chmod(DATA,0o700)
        unit_dir=UNIT_DIR;unit=unit_dir/SERVICE;backup_unit=unit_dir/'index-options-order-backup.service';timer=unit_dir/TIMER
        for p in (unit,backup_unit,timer):no_links(p)
        code=release/'aws/live/order_host.py'
        print('Preflight: checking the actual trading login, full FYERS contract stream and journal before service changes...',flush=True)
        run(['sudo','-u','mentor','--',sys.executable,str(code),'preflight'],cwd=Path('/tmp'),env=env,timeout=90)
        hardening=f'''User=mentor
Group=mentor
WorkingDirectory={release}
Environment=PYTHONDONTWRITEBYTECODE=1
Environment=PATH={Path(shutil.which('node')).parent}:/usr/local/bin:/usr/bin:/bin
UMask=0077
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths={DATA} /var/lib/index-options-mentor/live-feed
RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX
'''
        unit_text=f'''[Unit]
Description=Index Options Mentor owned execution host (installed DISABLED)
After=network-online.target index-options-journal.service index-options-marketdata.service
[Service]
{hardening}ExecStart=/usr/bin/python3 {code}
Restart=on-failure
RestartSec=5
[Install]
WantedBy=multi-user.target
'''
        backup_text=f'[Unit]\nDescription=Daily owned execution ledger backup\n[Service]\nType=oneshot\n{hardening}ExecStart=/usr/bin/python3 {code} backup\n'
        timer_text='[Unit]\nDescription=Daily owned execution ledger backup timer\n[Timer]\nOnCalendar=*-*-* 20:25:00 Asia/Kolkata\nPersistent=true\n[Install]\nWantedBy=timers.target\n'
        nginx_files={p.resolve() for d in NGINX_DIRS for p in Path(d).glob('*') if p.is_file() and '.pre-' not in p.name}
        targets=[p for p in nginx_files if re.search(r'\bserver_name\s+[^;]*\bapi\.optionsmentor\.in\b',p.read_text())]
        if not targets:raise RuntimeError('Existing API host was not found; no configuration files changed.')
        route='''    # IOM_OWNED_ORDER_HOST_V1
    location ^~ /monitor/orders/ {
        client_max_body_size 8k;
        proxy_pass http://127.0.0.1:9078;
        proxy_read_timeout 30s;
        proxy_set_header Host $host;
    }
'''
        files=[config_file,unit,backup_unit,timer,*targets];previous={p:p.read_bytes() if p.exists() else None for p in files}
        old_active=active(SERVICE)=='active';old_enabled=subprocess.run(['systemctl','is-enabled','--quiet',SERVICE]).returncode==0
        old_timer=active(TIMER)=='active';old_timer_enabled=subprocess.run(['systemctl','is-enabled','--quiet',TIMER]).returncode==0
        try:
            config_file.write_text(json.dumps({'version':1,'realMoneyEnabled':False,'maxTradeAmount':30000,'feeReserve':100}));os.chown(config_file,0,user.pw_gid);os.chmod(config_file,0o640)
            for p,value in ((unit,unit_text),(backup_unit,backup_text),(timer,timer_text)):p.write_text(value);os.chmod(p,0o644)
            for p in targets:
                source=p.read_text()
                if 'IOM_OWNED_ORDER_HOST_V1' in source:continue
                if '/monitor/orders/' in source:raise RuntimeError('An unmanaged order route exists; refusing to replace it.')
                p.write_text(re.sub(r'(?m)^([ \t]*server_name\s+[^;]*\bapi\.optionsmentor\.in\b[^;]*;)',lambda m:route+m.group(1),source))
            run(['nginx','-t']);run(['systemctl','daemon-reload']);run(['systemctl','enable',SERVICE,TIMER]);run(['systemctl','restart',SERVICE,TIMER]);run(['systemctl','reload','nginx'])
            for attempt in range(80):
                try:
                    status=status_request('http://127.0.0.1:9078','/monitor/orders/status',secret,owner)
                    if status.get('realMoneyEnabled') is not False or status.get('mode')!='OWNED_EXECUTION_HOST':raise RuntimeError('Unexpected live status.')
                    break
                except Exception:
                    if attempt==79:raise RuntimeError('The disabled order host could not start.')
                    time.sleep(.5)
            print('Checking Netlify → signed AWS order host. No buy/sell requests are sent.',flush=True)
            website_checked=True
            try:result=status_request(NETLIFY,'/api/orders/maintenance-status',secret,owner)
            except urllib.error.HTTPError as error:
                # Netlify's private lock answers 401 before the website sees the check.
                # The app itself calls website -> server, so check that part there.
                if error.code!=401 or not args.site_is_private:raise
                website_checked=False
                print('The private website refused the server check (401). Checking the public server address instead.',flush=True)
                result=status_request(PUBLIC_API,'/monitor/orders/status',secret,owner)
            if result.get('realMoneyEnabled') is not False or result.get('actualLiveExecutionHostReleased') is not True:raise RuntimeError('Deployed order-host status did not pass.')
            run(['systemctl','start','index-options-order-backup.service'])
            if states()!=before:raise RuntimeError('An existing app/feed/journal service changed state.')
            print(json.dumps({'ok':True,'stage':'ACTUAL_ORDER_HOST_INSTALLED_DISABLED','accountMatchesAws':True,'netlifyToAwsVerified':website_checked,'publicServerAddressVerified':not website_checked,'realMoneyEnabled':False,'ordersSent':0,'productionPositionsModified':False,'productionJournalTouched':False,'dailyLedgerBackupEnabled':True,'existingServices':before,'actualBrokerStopsAndExitsVerified':False}))
            if not website_checked:print('STILL TO CHECK: website to server. Sign in to the app and confirm the server status appears.')
            print('Actual order service connected and daily ledger backup enabled. Real-money sending remains OFF. Actual broker buy/stop/exit proof requires a user-executed live acceptance test.')
        except Exception:
            subprocess.run(['systemctl','stop',SERVICE,TIMER],check=False)
            # Disable while the unit files still exist, removing enablement links
            # before restoring/removing configuration files.
            if not old_enabled:subprocess.run(['systemctl','disable',SERVICE],check=False)
            if not old_timer_enabled:subprocess.run(['systemctl','disable',TIMER],check=False)
            for p,value in previous.items():
                if value is None:
                    if p.exists():p.unlink()
                else:p.write_bytes(value)
            run(['systemctl','daemon-reload'])
            if old_enabled:subprocess.run(['systemctl','enable',SERVICE],check=False)
            if old_timer_enabled:subprocess.run(['systemctl','enable',TIMER],check=False)
            if old_active:subprocess.run(['systemctl','start',SERVICE],check=False)
            if old_timer:subprocess.run(['systemctl','start',TIMER],check=False)
            subprocess.run(['nginx','-t'],check=False);subprocess.run(['systemctl','reload','nginx'],check=False)
            raise RuntimeError('Order-host connection did not pass. Its service and route configuration was restored. No real orders were sent.')

if __name__=='__main__':
    try:main()
    except Exception as error:
        print('STOP: '+(str(error) if isinstance(error,RuntimeError) else 'Order-host installation stopped safely; no real orders sent.'),file=sys.stderr);sys.exit(1)
