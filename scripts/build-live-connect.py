"""Reproducible no-order installer for the single FYERS socket and separate login."""
import base64,hashlib,json,zlib
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]
paths=[str(p.relative_to(ROOT)) for p in (ROOT/'aws/live').glob('*.py')]
paths+=['aws/live/exitSignals.mjs','aws/live/liveFeedPublisher.mjs']
paths += ['src/engine/'+name for name in ['managedPosition.js','positionMentor.js','coreOptionTrail.js','scalpOptionTrail.js','coreTargetIndexTrail.js']]
paths += [str(p.relative_to(ROOT)) for p in (ROOT/'tests').glob('live_*test.py')]
paths += ['tests/live-feed-publisher.test.mjs']
files={p:(ROOT/p).read_text() for p in sorted(paths)}
files['package.json']='{"type":"module"}\n'
raw=json.dumps({'format':3,'files':files},sort_keys=True,separators=(',',':')).encode()
source=(ROOT/'scripts/live-connect-template.py').read_text().replace('PAYLOAD_PLACEHOLDER',base64.b64encode(zlib.compress(raw,9)).decode()).replace('HASH_PLACEHOLDER',hashlib.sha256(raw).hexdigest())
file=ROOT/'public/iom-live-connect.py';file.write_text(source)
print(hashlib.sha256(source.encode()).hexdigest()+'  '+str(file))
