"""Package the real execution runtime with sending disabled and no credentials."""
import base64,hashlib,json,zlib
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]
paths=[str(p.relative_to(ROOT)) for p in (ROOT/'aws/live').glob('*.py')]
paths+=['aws/live/exitSignals.mjs','aws/live/entrySignals.mjs','aws/live/liveFeedPublisher.mjs']
paths += ['src/engine/'+name for name in ['managedPosition.js','positionMentor.js','coreOptionTrail.js','scalpOptionTrail.js','coreTargetIndexTrail.js','researchStrategy.js','scalpStrategy.js','tradeAmount.js']]
paths += ['server/'+name for name in ['mentor.js','mentorBase.js','mentorAdaptive.js']]
paths += [str(p.relative_to(ROOT)) for p in (ROOT/'tests').glob('live_*test.py')]+['tests/lift_lot_limit.py']
paths += ['tests/live-feed-publisher.test.mjs','tests/order-host-auth.test.mjs','tests/entry-signals.test.mjs','netlify/functions/orders.mjs','netlify/functions/execution.mjs','netlify/functions/lib/appAuth.mjs','netlify/functions/auth.mjs','tests/helpers/appSession.mjs']
files={p:(ROOT/p).read_text() for p in sorted(paths)};files['package.json']='{"type":"module"}\n'
raw=json.dumps({'format':4,'files':files},sort_keys=True,separators=(',',':')).encode()
source=(ROOT/'scripts/order-host-template.py').read_text().replace('PAYLOAD_PLACEHOLDER',base64.b64encode(zlib.compress(raw,9)).decode()).replace('HASH_PLACEHOLDER',hashlib.sha256(raw).hexdigest())
file=ROOT/'public/iom-order-host.py';file.write_text(source)
print(hashlib.sha256(source.encode()).hexdigest()+'  '+str(file))
