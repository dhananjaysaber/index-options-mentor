import base64,hashlib,json,zlib
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]
paths=[str(p.relative_to(ROOT)) for p in (ROOT/'aws/live').glob('*.py')]
paths+=['aws/live/exitSignals.mjs','netlify/functions/execution.mjs']
paths += ['src/engine/'+name for name in ['managedPosition.js','positionMentor.js','coreOptionTrail.js','scalpOptionTrail.js','coreTargetIndexTrail.js']]
paths += [str(p.relative_to(ROOT)) for p in (ROOT/'tests').glob('live_*test.py')]
paths += ['tests/execution-connection.test.mjs']
files={p:(ROOT/p).read_text() for p in sorted(paths)}
files['package.json']='{"type":"module"}\n'
raw=json.dumps({'format':2,'files':files},sort_keys=True,separators=(',',':')).encode()
text=(ROOT/'scripts/execution-connect-template.py').read_text().replace('PAYLOAD_PLACEHOLDER',base64.b64encode(zlib.compress(raw,9)).decode()).replace('HASH_PLACEHOLDER',hashlib.sha256(raw).hexdigest())
file=ROOT/'public/iom-execution-connect.py';file.write_text(text)
print(hashlib.sha256(text.encode()).hexdigest()+'  '+str(file))
