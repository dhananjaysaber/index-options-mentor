"""Publish the same audited one-shot read-only checker; no embedded secrets."""
import hashlib
from pathlib import Path
root = Path(__file__).resolve().parents[1]
content = (root/'aws/readiness/fyers_readiness.py').read_bytes()
output = root/'public/iom-fyers-readiness.py'
output.write_bytes(content)
print(hashlib.sha256(content).hexdigest()+'  '+str(output))
