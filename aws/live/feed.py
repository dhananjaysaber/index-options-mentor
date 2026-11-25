"""Fresh, independent option/index times from the existing Node FYERS socket.

No network requests and no broker mutation methods. Stale/disconnected data cannot
become an execution quote; a fresh index never refreshes an old option price.
"""
import json
import math
import os
from pathlib import Path
import re
import stat
import tempfile
import time

INDEX = 'NSE:NIFTY50-INDEX'
OPTION = re.compile(r'NSE:NIFTY[A-Z0-9]+(?:CE|PE)')


def number(value):
    return type(value) in (int, float) and math.isfinite(value)


class Feed:
    def __init__(self, root, clock=time.time):
        self.root, self.clock = Path(root), clock

    def subscriptions(self, symbols):
        symbols = sorted(set(symbols))
        if len(symbols) > 20 or any(not isinstance(s, str) or not OPTION.fullmatch(s) for s in symbols):
            raise ValueError('INVALID_LIVE_SUBSCRIPTIONS')
        fd, temp = tempfile.mkstemp(prefix='.subscriptions-', dir=self.root)
        try:
            with os.fdopen(fd, 'w') as handle:
                json.dump({'version':1, 'at':self.clock()*1000, 'symbols':symbols}, handle)
                handle.flush(); os.fsync(handle.fileno())
            os.replace(temp, self.root/'subscriptions.json')
        finally:
            if os.path.exists(temp): os.unlink(temp)

    def _read(self):
        file = self.root/'quotes.json'
        if any(p.is_symlink() for p in [file, *file.parents]): raise ValueError('UNSAFE_FEED_PATH')
        fd = os.open(file, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
        with os.fdopen(fd, 'rb') as handle:
            info = os.fstat(handle.fileno())
            if not stat.S_ISREG(info.st_mode) or info.st_size > 65536 or info.st_mode & 0o027:
                raise ValueError('UNSAFE_FEED_FILE')
            data = json.load(handle)
        now = self.clock()*1000
        if data.get('version') != 1 or data.get('connected') is not True or not number(data.get('publishedAt')) or not -1000 <= now-data['publishedAt'] <= 3000:
            raise ValueError('FEED_DISCONNECTED_OR_STALE')
        rows = data.get('quotes')
        if not isinstance(rows, list) or len(rows) > 21: raise ValueError('INVALID_FEED')
        result = {}
        for row in rows:
            if not isinstance(row, dict): raise ValueError('INVALID_FEED')
            symbol = row.get('symbol')
            if not isinstance(symbol, str) or not (symbol == INDEX or OPTION.fullmatch(symbol)) or symbol in result:
                raise ValueError('INVALID_FEED_SYMBOL')
            if not number(row.get('at')) or not -1000 <= now-row['at'] <= 3000 or not number(row.get('price')) or row['price'] <= 0:
                continue
            result[symbol] = row
        return result

    def quote(self, symbol):
        row = self._read().get(symbol)
        if not row or not number(row.get('bid')) or not number(row.get('ask')) or not 0 < row['bid'] <= row['ask']:
            raise ValueError('FRESH_BID_ASK_REQUIRED')
        return {'symbol':symbol, 'at':row['at']/1000, 'bid':row['bid'], 'ask':row['ask']}

    def pair(self, symbol):
        rows = self._read()
        option, index = rows.get(symbol), rows.get(INDEX)
        if not OPTION.fullmatch(symbol) or not option or not index: raise ValueError('FRESH_OPTION_AND_INDEX_REQUIRED')
        # Both independent timestamps have already passed the freshness check.
        from datetime import datetime, timezone
        return {'optionSymbol':symbol, 'optionPrice':option['price'], 'nifty':index['price'],
                'at':datetime.fromtimestamp(max(option['at'],index['at'])/1000, timezone.utc).isoformat(),
                'optionAt':option['at'], 'indexAt':index['at']}
