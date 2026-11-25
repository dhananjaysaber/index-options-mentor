import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';
import journal from '../netlify/functions/journal.mjs';

test('duplicate paper exit traverses the signed gateway and persists one SQLite record', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'iom-http-replay-'));
  const secret = 'local-integration-key-'.repeat(4);
  const configuration = join(directory, 'config.json');
  const serviceDirectory = fileURLToPath(new URL('../aws/journal/', import.meta.url));
  await writeFile(configuration, JSON.stringify({ secret, netlify: 'https://optionsmentor.netlify.app' }));
  const python = spawn('python3', ['-u', '-c', `
import sys
sys.path.insert(0, ${JSON.stringify(serviceDirectory)})
import service
server = service.ThreadingHTTPServer(('127.0.0.1', 0), service.Handler)
server.journal = service.Journal(service.DATABASE)
print(server.server_port, flush=True)
server.serve_forever()
`], { env: { ...process.env, IOM_JOURNAL_ROOT: directory, IOM_JOURNAL_CONFIG: configuration }, stdio: ['ignore', 'pipe', 'pipe'] });
  const originalFetch = globalThis.fetch;
  const previousNetlify = globalThis.Netlify;
  try {
    const [output] = await Promise.race([
      once(python.stdout, 'data'),
      once(python, 'exit').then(() => { throw Error('SQLite test service exited before startup'); }),
      new Promise((_, reject) => { const timer = setTimeout(() => reject(Error('SQLite startup timed out')), 10000); timer.unref(); })
    ]);
    const port = Number(String(output).trim());
    assert.ok(port > 0);
    const settings = { JOURNAL_STORAGE: 'sqlite', AWS_PAPER_SYNC_BASE: 'https://api.optionsmentor.in', AWS_PAPER_SYNC_SECRET: secret };
    globalThis.Netlify = { env: { get: name => settings[name] } };
    globalThis.fetch = (url, options) => {
      assert.equal(url, 'https://api.optionsmentor.in/journal/bridge');
      return originalFetch(`http://127.0.0.1:${port}/journal/bridge`, options);
    };
    const closedAt = new Date().toISOString();
    const event = { id: 'close:http-replay', type: 'TRADE_CLOSED', queuedAt: closedAt,
      trade: { id: 'http-replay', mode: 'SIMULATION', entry: 100, exit: 110,
        quantity: 65, pnl: 650, closedAt, closedBy: 'AWS_MONITOR',
        exitPriceSource: 'OBSERVED_OPTION_QUOTE', executionMode: 'PAPER_ONLY', brokerOrderPlaced: false } };
    for (let delivery = 0; delivery < 2; delivery++) {
      const response = await journal(new Request('https://optionsmentor.netlify.app/api/journal', {
        method: 'POST', body: JSON.stringify({ action: 'journal_event', event })
      }));
      assert.equal(response.status, 200);
      assert.equal((await response.json()).ok, true);
    }
    const health = await (await journal(new Request('https://optionsmentor.netlify.app/api/journal?health=1'))).json();
    assert.equal(health.storage, 'sqlite');
    assert.equal(health.trades, 1);
    assert.equal(health.events, 1);
    const history = await (await journal(new Request('https://optionsmentor.netlify.app/api/journal?limit=1000'))).json();
    assert.equal(history.trades.length, 1);
    assert.equal(history.trades[0].exit, 110);
    assert.equal(history.trades[0].closedBy, 'AWS_MONITOR');
    python.kill('SIGTERM');
    await once(python, 'exit');
    const counts = execFileSync('python3', ['-c', `
import sqlite3,sys,json
db=sqlite3.connect(sys.argv[1])
print(json.dumps([db.execute('SELECT COUNT(*) FROM trades').fetchone()[0],db.execute('SELECT COUNT(*) FROM events').fetchone()[0]]))
`, join(directory, 'journal.sqlite3')], { encoding: 'utf8' });
    assert.deepEqual(JSON.parse(counts), [1, 1]);
  } finally {
    globalThis.fetch = originalFetch;
    globalThis.Netlify = previousNetlify;
    if (python.exitCode === null && python.signalCode === null) {
      python.kill('SIGTERM');
      await once(python, 'exit');
    }
    await rm(directory, { recursive: true, force: true });
  }
});
