import concurrent.futures
import hashlib
import json
import sqlite3
import sys
import tempfile
import threading
import time
import unittest
import urllib.error
import urllib.request
import uuid
from datetime import datetime, timezone
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'aws' / 'journal'))
from store import Journal
import service


def event(kind='TRADE_CLOSED', trade_id='test-trade', price=110):
    now = datetime.now(timezone.utc).isoformat()
    return {'id': f'{kind}:{trade_id}', 'type': kind, 'queuedAt': now,
        'trade': {'id': trade_id, 'mode': 'SIMULATION', 'entry': 100, 'exit': price,
            'quantity': 65, 'pnl': (price - 100) * 65,
            **({'closedAt': now} if kind == 'TRADE_CLOSED' else {})}}


class StoreTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.file = Path(self.directory.name) / 'journal.sqlite3'
        self.journal = Journal(self.file)

    def tearDown(self):
        self.directory.cleanup()

    def test_concurrent_exit_replay_is_one_trade_and_one_event(self):
        closed = event()
        with concurrent.futures.ThreadPoolExecutor(max_workers=12) as pool:
            results = list(pool.map(lambda _: self.journal.event(closed), range(30)))
        self.assertTrue(all(result['ok'] for result in results))
        self.assertEqual(self.journal.health()['trades'], 1)
        self.assertEqual(self.journal.health()['events'], 1)
        self.assertEqual(Journal(self.file).list_trades()['trades'][0]['exit'], 110)

    def test_late_open_and_competing_close_preserve_final_exit(self):
        closed = event()
        self.journal.event(closed)
        self.journal.event(event('TRADE_OPENED'))
        second = event(price=39.5)
        second['id'] = 'aws-different-event'
        self.journal.event(second)
        rows = self.journal.list_trades()['trades']
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]['exit'], 110)
        self.assertEqual(self.journal.health()['events'], 3)

    def test_reusing_event_id_for_different_trade_is_rejected(self):
        first = event()
        self.journal.event(first)
        different = event(trade_id='different')
        different['id'] = first['id']
        with self.assertRaisesRegex(ValueError, 'CONFLICT'):
            self.journal.event(different)
        self.assertEqual(self.journal.health()['trades'], 1)

    def test_old_checkpoint_cannot_replace_newer_checkpoint(self):
        current = event('POSITION_CHECKPOINT')
        self.journal.event(current)
        old = event('POSITION_CHECKPOINT')
        old['id'] = 'old-checkpoint'
        old['queuedAt'] = '2020-01-01T00:00:00Z'
        old['trade']['entry'] = 10
        self.journal.event(old)
        self.assertEqual(self.journal.pending_exports()[0]['payload']['event']['trade']['entry'], 100)

    def test_backup_restores_all_tables_and_checks_integrity(self):
        self.journal.event(event())
        backup = self.journal.backup(Path(self.directory.name) / 'backups')
        restored = sqlite3.connect(backup['file'])
        self.assertEqual(restored.execute('PRAGMA integrity_check').fetchone()[0], 'ok')
        self.assertEqual(restored.execute('SELECT COUNT(*) FROM events').fetchone()[0], 1)
        restored.close()
        self.assertEqual(hashlib.sha256(Path(backup['file']).read_bytes()).hexdigest(), backup['sha256'])

    def test_export_retry_and_ack_do_not_lose_newer_updates(self):
        self.journal.event(event('TRADE_OPENED'))
        job = self.journal.pending_exports()[0]
        self.assertEqual(self.journal.pending_exports()[0], job)
        self.journal.event(event())
        self.journal.acknowledge_export(job)
        next_job = self.journal.pending_exports()[0]
        self.assertGreater(next_job['version'], job['version'])
        self.journal.acknowledge_export(next_job)
        self.assertEqual(self.journal.pending_exports(), [])

    def test_import_transaction_rolls_back_bad_row_and_can_retry(self):
        first = event()['trade']
        with self.assertRaises(ValueError):
            self.journal.import_trades([first, {'id': 'broken'}])
        self.assertEqual(self.journal.health()['trades'], 0)
        self.journal.import_trades([first])
        self.journal.import_trades([first])
        self.assertEqual(self.journal.health()['trades'], 1)
        self.assertEqual(self.journal.pending_exports(), [])

    def test_failed_export_keeps_pending_rows_and_backup(self):
        self.journal.event(event())
        with patch.object(service, 'ROOT', Path(self.directory.name)), patch.object(service, 'sheet_request', side_effect=RuntimeError('offline')):
            with self.assertRaises(RuntimeError):
                service.maintenance(self.journal)
        self.assertEqual(len(self.journal.pending_exports()), 1)
        self.assertEqual(len(list((Path(self.directory.name) / 'backups').glob('*.sqlite3'))), 1)

    def test_daily_exports_twice_but_sheet_has_one_trade_after_lost_ack(self):
        self.journal.event(event())
        sheet = {}
        events = set()
        def write(payload):
            receipt = payload['event']
            sheet[receipt['trade']['id']] = receipt['trade']
            events.add(receipt['id'])
            return {'ok': True}
        with patch.object(service, 'ROOT', Path(self.directory.name)), patch.object(service, 'sheet_request', side_effect=write), patch.object(service.time, 'sleep'):
            original = self.journal.acknowledge_export
            with patch.object(self.journal, 'acknowledge_export', side_effect=RuntimeError('crash after Sheets write')):
                with self.assertRaises(RuntimeError):
                    service.maintenance(self.journal)
            service.maintenance(self.journal)
        self.assertEqual(len(sheet), 1)
        self.assertEqual(len(events), 1)
        self.assertEqual(self.journal.pending_exports(), [])

    def test_http_signature_and_persisted_nonce_replay(self):
        server = service.ThreadingHTTPServer(('127.0.0.1', 0), service.Handler)
        server.journal = self.journal
        worker = threading.Thread(target=server.serve_forever, daemon=True)
        worker.start()
        secret = 'test-secret-' * 6
        body = json.dumps({'action': 'journal_event', 'event': event()}).encode()
        stamp, nonce = str(int(time.time() * 1000)), uuid.uuid4().hex
        headers = {'Content-Type': 'application/json', 'x-iom-time': stamp, 'x-iom-nonce': nonce,
            'x-iom-signature': service.signature(secret, stamp, nonce, 'POST', '/journal/bridge', body)}
        url = f'http://127.0.0.1:{server.server_port}/journal/bridge'
        try:
            with patch.object(service, 'credentials', return_value={'secret': secret}):
                with urllib.request.urlopen(urllib.request.Request(url, body, headers), timeout=5) as response:
                    self.assertTrue(json.load(response)['ok'])
                with self.assertRaises(urllib.error.HTTPError) as result:
                    urllib.request.urlopen(urllib.request.Request(url, body, headers), timeout=5)
                self.assertEqual(result.exception.code, 400)
                bad = {**headers, 'x-iom-signature': '0' * 64}
                with self.assertRaises(urllib.error.HTTPError) as result:
                    urllib.request.urlopen(urllib.request.Request(url, body, bad), timeout=5)
                self.assertEqual(result.exception.code, 401)
        finally:
            server.shutdown()
            server.server_close()
            worker.join()


if __name__ == '__main__':
    unittest.main()
