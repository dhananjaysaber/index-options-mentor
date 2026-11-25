#!/usr/bin/env python3
"""Install only the authenticated simulation-check host; real trading cannot be enabled."""
import argparse,base64,hashlib,hmac,json,os,pwd,re,shutil,sqlite3,subprocess,sys,tempfile,time,uuid,zlib
from pathlib import Path
import urllib.request

PAYLOAD='PAYLOAD_PLACEHOLDER'
DIGEST='HASH_PLACEHOLDER'
BASE=Path('/opt/index-options-mentor')
SERVICE='index-options-execution-check.service'
NETLIFY='https://deploy-preview-28--optionsmentor.netlify.app'
ROOT=Path('/var/lib/index-options-mentor/execution-check')


def run(args,**kw): return subprocess.run(args,check=True,**kw)
def unchanged_services():
    result={name:subprocess.check_output(['systemctl','show',name,'--property=ActiveState','--value'],text=True).strip()
            for name in ['index-options-mentor.service','index-options-journal.service','index-options-journal-daily.timer']}
    if any(value!='active' for value in result.values()): raise RuntimeError('App, journal and daily timer must remain active.')
    return result

def no_links(path):
    if any(p.is_symlink() for p in [path,*path.parents]): raise RuntimeError('Unsafe symlink in installation path.')

def pin_owner():
    data=json.loads(Path('/var/lib/index-options-mentor/paper-owner.json').read_text())
    def strings(value):
        if isinstance(value,str): yield value
        elif isinstance(value,dict):
            for v in value.values(): yield from strings(v)
        elif isinstance(value,list):
            for v in value: yield from strings(v)
    values={v for v in strings(data) if re.fullmatch(r'[a-f0-9]{64}',v)}
    if len(values)!=1: raise RuntimeError('The existing pinned FYERS owner could not be identified safely. No credentials were changed.')
    return values.pop()

def request(url,path,secret,owner,payload):
    body=json.dumps(payload,separators=(',',':')).encode();stamp=str(int(time.time()));nonce=uuid.uuid4().hex
    text='\n'.join(['v1',stamp,nonce,owner,'POST',path,hashlib.sha256(body).hexdigest()])
    signed=hmac.new(secret.encode(),text.encode(),hashlib.sha256).hexdigest()
    req=urllib.request.Request(url+path,body,headers={'Content-Type':'application/json','X-IOM-Time':stamp,'X-IOM-Nonce':nonce,'X-IOM-Owner':owner,'X-IOM-Signature':signed})
    class NoRedirect(urllib.request.HTTPRedirectHandler):
        def redirect_request(self,*args,**kwargs): return None
    with urllib.request.build_opener(NoRedirect).open(req,timeout=35) as response: return json.load(response)

def main():
    parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('--verify-only',action='store_true');parser.add_argument('--journal-store',type=Path)
    args=parser.parse_args()
    if sys.version_info<(3,12): raise RuntimeError('Python 3.12+ required.')
    node=shutil.which('node')
    if not node or int(subprocess.check_output([node,'--version'],text=True).strip().lstrip('v').split('.')[0])<20:
        raise RuntimeError('Node 20+ is required; the existing Node installation was not changed.')
    if not args.verify_only and (os.geteuid()!=0 or args.journal_store): raise RuntimeError('Use sudo python3; custom journal paths are verification-only.')
    source=(args.journal_store or BASE/'journal/store.py').resolve(strict=True)
    raw=zlib.decompress(base64.b64decode(PAYLOAD,validate=True))
    if hashlib.sha256(raw).hexdigest()!=DIGEST: raise RuntimeError('Package checksum failed.')
    package=json.loads(raw)
    if package.get('format')!=2: raise RuntimeError('Invalid package.')
    for name in package['files']:
        path=Path(name)
        if path.is_absolute() or '..' in path.parts or (name!='package.json' and not name.startswith(('aws/live/','src/engine/','netlify/functions/','tests/'))): raise RuntimeError('Invalid package path.')
    user=None;parent=None
    if not args.verify_only:
        before=unchanged_services();user=pwd.getpwnam('mentor')
        secret=json.loads(Path('/etc/index-options-journal.json').read_text()).get('secret','')
        if not isinstance(secret,str) or len(secret)<32: raise RuntimeError('Existing bridge secret is unavailable.')
        owner=pin_owner()
        parent=BASE/'execution-check/releases';no_links(parent);parent.mkdir(parents=True,exist_ok=True,mode=0o750)
        for directory in [BASE/'execution-check',parent]:os.chown(directory,0,user.pw_gid);os.chmod(directory,0o750)
    with tempfile.TemporaryDirectory(prefix='.execution-connect-',dir=parent) as temporary:
        stage=Path(temporary)
        for name,content in package['files'].items():
            file=stage/name;file.parent.mkdir(parents=True,exist_ok=True);file.write_text(content)
        copied=stage/'aws/journal/store.py';copied.parent.mkdir(parents=True,exist_ok=True);shutil.copyfile(source,copied)
        if user:
            for root,dirs,files in os.walk(stage):
                os.chown(root,0,user.pw_gid);os.chmod(root,0o750)
                for name in files:os.chown(Path(root)/name,0,user.pw_gid);os.chmod(Path(root)/name,0o640)
        env={'PATH':str(Path(node).parent)+':/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin','LANG':'C.UTF-8','TMPDIR':'/tmp','PYTHONDONTWRITEBYTECODE':'1'}
        prefix=['sudo','-u','mentor','--','env','PATH='+env['PATH']] if user else []
        print('Testing shared exit engines, protection races, authentication, HTTP connection and replay...',flush=True)
        run(prefix+[sys.executable,'-I','-m','unittest','discover','-s','tests','-p','live_*test.py','-q'],cwd=stage,env=env,timeout=150)
        run(prefix+[node,'--test','tests/execution-connection.test.mjs'],cwd=stage,env=env,timeout=60)
        if args.verify_only:
            print('PASS: connection package verified; no service installed or started.');return
        if unchanged_services()!=before:raise RuntimeError('Existing service status changed; no host selected.')
        destination=parent/DIGEST[:20];no_links(destination)
        if destination.exists():
            for name,content in package['files'].items():
                file=destination/name;no_links(file)
                if not file.is_file() or file.read_text()!=content:raise RuntimeError('Existing release differs; no overwrite performed.')
        else:stage.rename(destination)
        no_links(ROOT);ROOT.mkdir(parents=True,exist_ok=True,mode=0o700);os.chown(ROOT,user.pw_uid,user.pw_gid);os.chmod(ROOT,0o700)
        config_file=Path('/etc/index-options-execution-check.json');unit_file=Path('/etc/systemd/system')/SERVICE
        no_links(config_file);no_links(unit_file)
        config={'secret':secret,'ownerProof':owner,'journalSource':str(source),'dataRoot':str(ROOT),'realMoneyEnabled':False}
        config_text=json.dumps(config)
        unit=f'''[Unit]
Description=Index Options Mentor isolated execution diagnostics (NO REAL ORDERS)
After=network-online.target
[Service]
User=mentor
Group=mentor
WorkingDirectory={destination}
Environment=PATH={Path(node).parent}:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
ExecStart=/usr/bin/python3 {destination}/aws/live/diagnostic_host.py
Restart=on-failure
RestartSec=3
UMask=0077
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths={ROOT}
RestrictAddressFamilies=AF_INET AF_UNIX
IPAddressDeny=any
IPAddressAllow=localhost
[Install]
WantedBy=multi-user.target
'''
        route='''    # IOM_EXECUTION_DIAGNOSTICS_ONLY
    location ^~ /monitor/live/ {
        client_max_body_size 2k;
        proxy_pass http://127.0.0.1:9077;
        proxy_read_timeout 30s;
        proxy_set_header Host $host;
    }
'''
        nginx_files={p.resolve() for directory in ('/etc/nginx/sites-enabled','/etc/nginx/conf.d') for p in Path(directory).glob('*') if p.is_file() and '.pre-' not in p.name}
        targets=[p for p in nginx_files if re.search(r'\bserver_name\s+[^;]*\bapi\.optionsmentor\.in\b',p.read_text())]
        if not targets:raise RuntimeError('Existing API nginx host not found. No service changes made.')
        backups={p:(p.read_bytes() if p.exists() else None) for p in [config_file,unit_file,*targets]}
        old_service=unit_file.exists()
        old_active=subprocess.run(['systemctl','is-active','--quiet',SERVICE],check=False).returncode==0
        old_enabled=subprocess.run(['systemctl','is-enabled','--quiet',SERVICE],check=False).returncode==0
        try:
            config_file.write_text(config_text);os.chown(config_file,0,user.pw_gid);os.chmod(config_file,0o640)
            unit_file.write_text(unit);os.chmod(unit_file,0o644)
            for file in targets:
                original=file.read_text()
                if 'IOM_EXECUTION_DIAGNOSTICS_ONLY' in original:continue
                if '/monitor/live/' in original:raise RuntimeError('Unmanaged execution route exists; refusing to replace it.')
                shutil.copy2(file,file.with_name(file.name+'.pre-execution-'+str(int(time.time()))))
                file.write_text(re.sub(r'(?m)^([ \t]*server_name\s+[^;]*\bapi\.optionsmentor\.in\b[^;]*;)',lambda m:route+m.group(1),original))
            run(['nginx','-t']);run(['systemctl','daemon-reload']);run(['systemctl','enable',SERVICE]);run(['systemctl','restart',SERVICE]);run(['systemctl','reload','nginx'])
            for attempt in range(12):
                try:
                    status=request('http://127.0.0.1:9077','/monitor/live/status',secret,owner,{})
                    if status.get('realMoneyEnabled') is not False:raise RuntimeError('Unexpected trading status.')
                    break
                except Exception:
                    if attempt==11:raise
                    time.sleep(.5)
            print('Checking Netlify → authenticated AWS host → shared exits → isolated journal...',flush=True)
            result=request(NETLIFY,'/api/execution/maintenance',secret,owner,{'checkId':str(uuid.uuid4())})
            if result.get('realMoneyEnabled') is not False or result.get('brokerNetworkRequests')!=0 or result.get('productionJournalTouched') is not False or len(result.get('checks',[]))!=2 or not all(r.get('passed') and r.get('journalRows')==1 and r.get('replayCreatedOrders')==0 for r in result['checks']):raise RuntimeError('End-to-end diagnostic check did not pass.')
            run(['systemctl','is-active','--quiet',SERVICE])
            if unchanged_services()!=before:raise RuntimeError('Existing app/journal service status changed.')
            print(json.dumps({'ok':True,'stage':'CONNECTED_SIMULATION_ONLY','realMoneyEnabled':False,'productionJournalTouched':False,'existingServices':before,'checks':result['checks']}))
            print('AWS connection and automatic exit/replay checks passed. Real-money trading remains OFF.')
        except Exception:
            if not old_service:
                subprocess.run(['systemctl','disable','--now',SERVICE],check=False)
            for file,content in backups.items():
                if content is None:
                    if file.exists():file.unlink()
                else:file.write_bytes(content)
            run(['systemctl','daemon-reload'])
            if old_service:
                subprocess.run(['systemctl','restart' if old_active else 'stop',SERVICE],check=False)
                subprocess.run(['systemctl','enable' if old_enabled else 'disable',SERVICE],check=False)
            subprocess.run(['nginx','-t'],check=False);subprocess.run(['systemctl','reload','nginx'],check=False)
            raise RuntimeError('Connection setup did not pass. Its service/config/route changes were rolled back; no real orders were sent.')

if __name__=='__main__':
    try:main()
    except Exception as error:print('STOP: '+str(error),file=sys.stderr);sys.exit(1)
