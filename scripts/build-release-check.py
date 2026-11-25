"""Build one self-contained check with no embedded credentials or trading runtime."""
import base64, hashlib, json, zlib
from pathlib import Path
root=Path(__file__).resolve().parents[1]
files={name:(root/'aws/readiness'/name).read_text() for name in ('fyers_readiness.py','release_check.py')}
raw=json.dumps(files,sort_keys=True,separators=(',',':')).encode()
payload=base64.b64encode(zlib.compress(raw,9)).decode()
digest=hashlib.sha256(raw).hexdigest()
code='''#!/usr/bin/env python3
# Self-contained read/account + simulation + journal maintenance check. No real orders.
import base64, hashlib, json, os, subprocess, sys, tempfile, zlib
from pathlib import Path
raw=zlib.decompress(base64.b64decode(PAYLOAD))
if hashlib.sha256(raw).hexdigest()!=DIGEST: raise SystemExit('Package checksum failed.')
files=json.loads(raw)
if set(files)!={'fyers_readiness.py','release_check.py'}: raise SystemExit('Invalid package.')
if os.geteuid()!=0: raise SystemExit('Run with sudo on the existing AWS host.')
with tempfile.TemporaryDirectory(prefix='iom-release-check-') as directory:
    os.chmod(directory,0o755)
    for name,content in files.items():
        file=Path(directory)/name
        file.write_text(content)
        os.chmod(file,0o644)
    result=subprocess.run([sys.executable,'-I',str(Path(directory)/'release_check.py')],cwd='/tmp')
    sys.exit(result.returncode)
'''.replace('PAYLOAD',repr(payload)).replace('DIGEST',repr(digest))
out=root/'public/iom-release-check.py';out.write_text(code)
print(hashlib.sha256(code.encode()).hexdigest()+'  '+str(out))
