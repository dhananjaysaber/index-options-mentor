#!/usr/bin/env python3
"""Consolidated account, simulation, journal backup/export/replay verification.

Never installs/enables a trading runtime or sends broker mutations. Production
journal writes are limited to backup metadata and acknowledgements after Sheets
accepts an existing saved record. No invented trades enter the production DB.
"""
import argparse
import contextlib
import fcntl
import hashlib
import hmac
import io
import json
import os
from pathlib import Path
import re
import sqlite3
import subprocess
import sys
import time
import uuid
import urllib.error
import urllib.request

sys.path.insert(0, str(Path(__file__).resolve().parent))
import fyers_readiness as account


class ExportFailure(Exception):
    pass


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs): return None


_last_sheet_started = 0.0


def signed_sheet_call(configuration, payload):
    global _last_sheet_started
    origin = configuration.get('netlify', '')
    secret = configuration.get('secret', '')
    if (not re.fullmatch(r'https://[a-z0-9-]+\.netlify\.app', origin)
            or not isinstance(secret, str) or len(secret) < 32):
        raise ExportFailure('JOURNAL_CONNECTION_CONFIGURATION_INVALID')
    path = '/api/journal-maintenance'
    body = json.dumps(payload, separators=(',', ':')).encode()
    stamp, nonce = str(int(time.time()*1000)), uuid.uuid4().hex
    canonical = '\n'.join([stamp, nonce, 'POST', path, hashlib.sha256(body).hexdigest()])
    request = urllib.request.Request(origin+path, body, headers={
        'Content-Type': 'application/json', 'x-iom-time': stamp, 'x-iom-nonce': nonce,
        'x-iom-signature': hmac.new(secret.encode(), canonical.encode(), hashlib.sha256).hexdigest()})
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())
    delay = 3 - (time.monotonic() - _last_sheet_started)
    if delay > 0: time.sleep(delay)
    _last_sheet_started = time.monotonic()
    try:
        with opener.open(request, timeout=55) as response:
            raw = response.read(8_000_001)
            if len(raw) > 8_000_000: raise ExportFailure('SHEETS_RESPONSE_TOO_LARGE')
            result = json.loads(raw)
    except urllib.error.HTTPError as error:
        status = error.code
        reason = 'EXPORT_GATEWAY_HTTP_'+str(status)
        try:
            data = json.loads(error.read(65536))
            code = data.get('error') if isinstance(data, dict) else None
            if isinstance(code, str) and (code in {
                'SHEETS_NOT_CONFIGURED', 'SHEETS_NON_JSON_RESPONSE',
                'SHEETS_REJECTED_REQUEST', 'SHEETS_EXPORT_UNAVAILABLE'}
                    or re.fullmatch(r'SHEETS_HTTP_[1-5][0-9]{2}', code)):
                reason = code
        except (OSError, ValueError): pass
        finally: error.close()
        raise ExportFailure(reason) from None
    except (OSError, ValueError, urllib.error.URLError):
        raise ExportFailure('SHEETS_CONNECTION_UNAVAILABLE') from None
    if not isinstance(result, dict) or result.get('ok') is not True:
        raise ExportFailure('SHEETS_REJECTED_REQUEST')
    return result


def audit_journal(journal, root, sheet_call, pause=time.sleep):
    root = Path(root)
    before = journal.health()
    report = {'storage': 'sqlite', 'trades': before['trades'], 'events': before['events'],
              'exportedExistingRecords': 0, 'replayVerified': False, 'exportPassed': False}
    dbfile = root/'journal.sqlite3'
    with sqlite3.connect('file:'+str(dbfile)+'?mode=ro', uri=True) as db:
        if db.execute('PRAGMA integrity_check').fetchone()[0] != 'ok':
            raise ExportFailure('SQLITE_INTEGRITY_CHECK_FAILED')
    backup = journal.backup(root/'backups')
    backupfile = Path(backup['file'])
    if backupfile.parent.resolve() != (root/'backups').resolve() or backupfile.is_symlink():
        raise ExportFailure('UNEXPECTED_BACKUP_PATH')
    digest = hashlib.sha256(backupfile.read_bytes()).hexdigest()
    if digest != backup['sha256']: raise ExportFailure('BACKUP_HASH_MISMATCH')
    with sqlite3.connect('file:'+str(backupfile)+'?mode=ro', uri=True) as db:
        if db.execute('PRAGMA integrity_check').fetchone()[0] != 'ok':
            raise ExportFailure('BACKUP_INTEGRITY_CHECK_FAILED')
    report['backupVerified'] = True
    report['backupFile'] = backupfile.name
    report['backupSha256'] = digest
    try:
        health = sheet_call({'action': 'health'})
        # The history endpoint filters closed trades and is capped; use a full
        # identifier receipt instead of comparing its length with total rows.
        shipped = 0
        while shipped < 1000:
            jobs = journal.pending_exports()
            if not jobs: break
            for job in jobs:
                if shipped >= 1000: break
                sheet_call(job['payload'])
                journal.acknowledge_export(job)
                shipped += 1
                report['exportedExistingRecords'] = shipped
                pause(3)
        if journal.pending_exports(): raise ExportFailure('EXPORT_BACKLOG_REMAINS')
        report['exportPassed'] = True
        journal.mark('last_export_at', time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()))
        journal.mark('last_export_error', '')
        # Replay one existing closed record, never create a fake production trade.
        with sqlite3.connect('file:'+str(dbfile)+'?mode=ro', uri=True) as db:
            db.row_factory = sqlite3.Row
            row = db.execute('SELECT * FROM trades WHERE closed=1 ORDER BY event_at DESC,id LIMIT 1').fetchone()
        if row is None: raise ExportFailure('NO_EXISTING_CLOSED_TRADE_FOR_REPLAY')
        trade = json.loads(row['payload'])
        payload = {'action': 'journal_event', 'event': {
            'id': f"sqlite:{row['id']}:{row['version']}", 'type': 'TRADE_CLOSED',
            'trade': trade, 'queuedAt': trade.get('closedAt'), 'source': 'sqlite_daily_export'}}
        receipt_payload = {'action': 'journal_receipt', 'tradeId': row['id'],
                           'eventId': payload['event']['id']}
        def receipt():
            value = sheet_call(receipt_payload)
            counts = ('tradeRows', 'closedTradeRows', 'eventRows', 'matchingEventTradeRows', 'closedExitRowsForTrade',
                      'scannedTradeRows', 'scannedEventRows')
            if (value.get('complete') is not True or value.get('tradeId') != row['id']
                    or value.get('eventId') != payload['event']['id']
                    or any(type(value.get(k)) is not int or value[k] < 0 for k in counts)
                    or value['closedTradeRows'] > value['tradeRows']
                    or value['matchingEventTradeRows'] > value['eventRows']
                    or value['tradeRows'] > value['scannedTradeRows']
                    or value['eventRows'] > value['scannedEventRows']
                    or value['closedExitRowsForTrade'] > value['scannedEventRows']):
                raise ExportFailure('SHEETS_FULL_RECEIPT_NOT_VERIFIED')
            return value
        initial = receipt()
        if (initial['tradeRows'] != 1 or initial['closedTradeRows'] != 1
                or initial['eventRows'] > 1
                or initial['matchingEventTradeRows'] != initial['eventRows']
                or initial['closedExitRowsForTrade'] != initial['eventRows']):
            raise ExportFailure('SHEETS_EXISTING_TRADE_OR_EVENT_NOT_UNIQUE')
        for delivery in range(2):
            pause(3)
            sheet_call(payload)
        final = receipt()
        if any(final[k] != 1 for k in ('tradeRows', 'closedTradeRows', 'eventRows', 'matchingEventTradeRows', 'closedExitRowsForTrade')):
            raise ExportFailure('SHEETS_REPLAY_CREATED_DUPLICATE_OR_INVALID_EXIT')
        report['receiptSource'] = 'COMPLETE_SHEET_IDENTIFIER_SCAN'
        report['scannedSheetTradeRows'] = final['scannedTradeRows']
        report['matchingSheetExitEventsAfterReplay'] = 1
        report['replayVerified'] = True
        report['replayedExistingTradeHash'] = hashlib.sha256(row['id'].encode()).hexdigest()[:16]
        report['matchingSheetRowsAfterReplay'] = 1
        journal.mark('last_export_at', time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()))
        journal.mark('last_export_error', '')
        journal.mark('last_verification_error', '')
    except ExportFailure as error:
        if report['exportPassed']:
            journal.mark('last_verification_error', str(error))
            report['verificationBlocker'] = str(error)
        else:
            journal.mark('last_export_error', str(error))
            report['exportBlocker'] = str(error)
    after = journal.health()
    report['pendingExportRecords'] = len(journal.pending_exports())
    report['productionTradeCountUnchanged'] = after['trades'] == before['trades']
    report['productionEventCountUnchanged'] = after['events'] == before['events']
    report['passed'] = bool(report.get('backupVerified') and report['replayVerified']
        and report['productionTradeCountUnchanged'] and report['productionEventCountUnchanged']
        and not report['pendingExportRecords'])
    return report


def journal_worker():
    # Called as mentor, never initialise or write the actual database as root.
    import pwd
    if os.geteuid() != pwd.getpwnam('mentor').pw_uid:
        raise ExportFailure('JOURNAL_CHECK_REQUIRES_MENTOR_USER')
    root = Path('/var/lib/index-options-mentor/journal')
    dbfile = root/'journal.sqlite3'
    if not dbfile.is_file() or dbfile.is_symlink():
        raise ExportFailure('EXISTING_JOURNAL_DATABASE_REQUIRED')
    with (root/'daily.lock').open('a') as lock:
        try: fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError: raise ExportFailure('DAILY_BACKUP_OR_EXPORT_IS_ALREADY_RUNNING') from None
        sys.path.insert(0, '/opt/index-options-mentor/journal')
        from store import Journal
        configuration = json.loads(Path('/etc/index-options-journal.json').read_text())
        return audit_journal(Journal(dbfile), root, lambda payload: signed_sheet_call(configuration, payload))


def check_simulation():
    import pwd
    uid = pwd.getpwnam('mentor').pw_uid
    configuration = account.secure_json('/etc/index-options-journal.json', uid)
    secret = configuration.get('secret', '')
    owner = account.owner_proof(account.secure_json(account.BASE/'paper-owner.json', uid))
    if not isinstance(secret, str) or len(secret) < 32: raise ExportFailure('BRIDGE_SECRET_UNAVAILABLE')
    path = '/api/execution/maintenance'
    body = json.dumps({'checkId': str(uuid.uuid4())}, separators=(',', ':')).encode()
    stamp, nonce = str(int(time.time())), uuid.uuid4().hex
    canonical = '\n'.join(['v1', stamp, nonce, owner, 'POST', path, hashlib.sha256(body).hexdigest()])
    request = urllib.request.Request('https://deploy-preview-28--optionsmentor.netlify.app'+path,
        body, headers={'Content-Type': 'application/json', 'X-IOM-Time': stamp,
        'X-IOM-Nonce': nonce, 'X-IOM-Owner': owner,
        'X-IOM-Signature': hmac.new(secret.encode(), canonical.encode(), hashlib.sha256).hexdigest()})
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())
    try:
        with opener.open(request, timeout=40) as response: result = json.load(response)
    except Exception: raise ExportFailure('DEPLOYED_SIMULATION_CHECK_UNAVAILABLE') from None
    # Host protocol returns its result under result on the maintenance path.
    if isinstance(result, dict) and isinstance(result.get('result'), dict): result = result['result']
    rows = result.get('checks') if isinstance(result, dict) else None
    if (not isinstance(rows, list) or len(rows) != 2 or result.get('realMoneyEnabled') is not False
            or result.get('mode') != 'SIMULATED_EXECUTION_CHECK'
            or result.get('productionJournalTouched') is not False or result.get('brokerNetworkRequests') != 0
            or {r.get('strategy') for r in rows if isinstance(r, dict)} != {'CORE', 'SCALP'}
            or any(r.get('passed') is not True or r.get('journalRows') != 1
                   or r.get('journalEvents') != 1 or r.get('replayCreatedOrders') != 0
                   for r in rows)):
        raise ExportFailure('DEPLOYED_SIMULATION_CHECK_DID_NOT_PASS')
    return {'passed': True, 'mode': 'SIMULATION_ONLY', 'checks': rows}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--journal-worker', action='store_true')
    args = parser.parse_args()
    if args.journal_worker:
        try: result = journal_worker()
        except ExportFailure as error: result = {'passed': False, 'exportBlocker': str(error)}
        except Exception: result = {'passed': False, 'exportBlocker': 'JOURNAL_CHECK_UNAVAILABLE'}
        print(json.dumps(result, sort_keys=True)); return 0
    if os.geteuid() != 0: raise SystemExit('Run this consolidated check using sudo.')
    print('Checking account, deployed simulated exits, backup and existing Sheets records...', flush=True)
    report = {'realMoneyEnabled': False, 'ordersSent': 0, 'servicesRestarted': False,
              'blockers': [], 'productionPositionsModified': False}
    try: before = account.service_state()
    except Exception: raise SystemExit('Could not verify existing service state; no changes made.')
    captured = io.StringIO()
    with contextlib.redirect_stdout(captured): account.main()
    report['account'] = json.loads(captured.getvalue())
    if not report['account'].get('readOnlyBrokerAccessPassed'):
        report['blockers'].append('FYERS_ACCOUNT_CHECK_FAILED')
    try:
        import pwd
        app_id = account.service_app_id(before[account.SERVICES[0]]['pid'], pwd.getpwnam('mentor').pw_uid)
        report['currentFyersAppType'] = 'TRADING' if app_id.endswith('-200') else 'NON_TRADING' if app_id.endswith('-100') else 'UNKNOWN'
        if report['currentFyersAppType'] != 'TRADING': report['blockers'].append('SEPARATE_TRADING_ENABLED_FYERS_APP_REQUIRED')
    except Exception: report['blockers'].append('FYERS_APP_TYPE_NOT_VERIFIED')
    try: report['simulation'] = check_simulation()
    except ExportFailure as error:
        report['simulation'] = {'passed': False, 'reason': str(error)}
        report['blockers'].append(str(error))
    print('Checking the journal; existing saved rows may be re-exported. No fake production trades are created.', flush=True)
    try:
        process = subprocess.run(['sudo', '-u', 'mentor', '--', sys.executable, '-I',
            str(Path(__file__).resolve()), '--journal-worker'], capture_output=True,
            text=True, cwd='/tmp', timeout=3900)
        if process.returncode != 0: raise ValueError('worker failed')
        report['journal'] = json.loads(process.stdout)
        if not report['journal'].get('passed'): report['blockers'].append('JOURNAL_EXPORT_OR_REPLAY_NOT_VERIFIED')
    except Exception:
        report['journal'] = {'passed': False, 'exportBlocker': 'JOURNAL_WORKER_UNAVAILABLE'}
        report['blockers'].append('JOURNAL_EXPORT_OR_REPLAY_NOT_VERIFIED')
    report['blockers'].extend(['ACTUAL_LIVE_EXECUTION_HOST_NOT_RELEASED',
        'LIVE_WEBSOCKET_EXIT_NOT_VERIFIED', 'ACTUAL_BROKER_ORDERS_AND_STOPS_NOT_VERIFIED'])
    try: report['existingServicesUnchanged'] = before == account.service_state()
    except Exception: report['existingServicesUnchanged'] = False
    if not report['existingServicesUnchanged']: report['blockers'].append('EXISTING_SERVICE_STATE_CHANGED')
    report['readyForRealMoney'] = False
    print(json.dumps(report, sort_keys=True))
    return 0


if __name__ == '__main__': sys.exit(main())
