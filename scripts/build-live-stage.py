"""Build the self-contained disabled-stage installer from committed sources."""
import base64
import hashlib
import json
import textwrap
import zlib
from pathlib import Path

ROOT=Path(__file__).resolve().parents[1]
paths=[f'aws/live/{n}' for n in ['orders.py','planner.py','execution.py','bridge.py','fyers_broker.py','README.md']]
paths += [f'tests/{n}' for n in ['live_orders_test.py','live_execution_test.py','live_bridge_test.py']]
files={p:(ROOT/p).read_text() for p in paths}
package={'format':1,'source':'content-addressed-package-v2','files':files,
         'sha256':{p:hashlib.sha256(v.encode()).hexdigest() for p,v in files.items()}}
raw=json.dumps(package,sort_keys=True,separators=(',',':')).encode()
code=(ROOT/'scripts/live-stage-template.py').read_text().replace('PAYLOAD_PLACEHOLDER',base64.b64encode(zlib.compress(raw,9)).decode()).replace('PACKAGE_HASH_PLACEHOLDER',hashlib.sha256(raw).hexdigest())
file=ROOT/'public/iom-live-stage.py'; file.write_text(code)
print(hashlib.sha256(code.encode()).hexdigest()+'  '+str(file))
