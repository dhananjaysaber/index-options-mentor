import { useEffect, useMemo, useRef, useState } from 'react';
import {
  analyseExpiryProxy,
  buildCohortAnalysis
} from '../services/researchAnalysis.js';
import {
  REPLAY_MODELS,
  STRUCTURE_PROBES
} from '../services/researchReplay.js';

export default function ResearchAnalysis({ history, brokerStatus }) {
  const [months, setMonths] = useState(6);
  const [evidence, setEvidence] = useState(null);
  const [replay, setReplay] = useState(null);
  const [loadStage, setLoadStage] = useState('idle');
  const [error, setError] = useState('');
  const [replayError, setReplayError] = useState('');
  const workerRef = useRef(null);
  const fiveMinuteRef = useRef([]);
  const historyRef = useRef(history);
  const evidenceRef = useRef(null);
  const activeRequestRef = useRef(0);
  historyRef.current = history;
  const cohorts = useMemo(() => buildCohortAnalysis(history), [history]);
  const expiryJournal = useMemo(() => analyseExpiryProxy(history), [history]);
  const loading = loadStage === 'five' || loadStage === 'three' || loadStage === 'replay';

  useEffect(() => {
    const worker = new Worker(new URL('../workers/researchReplayWorker.js', import.meta.url), { type: 'module' });
    workerRef.current = worker;

    worker.onmessage = event => {
      const message = event?.data || {};
      if (message.requestId !== activeRequestRef.current) return;

      if (message.type === 'evidence') {
        evidenceRef.current = message.evidence || null;
        setEvidence(message.evidence || null);
        return;
      }

      if (message.type === 'replay') {
        const nextReplay = message.replay || null;
        const nextEvidence = message.evidence || evidenceRef.current || null;
        evidenceRef.current = nextEvidence;
        setEvidence(nextEvidence);
        setReplay(nextReplay);
        setLoadStage('ready');
        writeAnalysisCache(months, {
          evidence: nextEvidence,
          replay: nextReplay,
          savedAt: Date.now()
        });
        return;
      }

      if (message.type === 'error') {
        setReplayError(message.message || 'Replay calculation failed.');
        setLoadStage('ready');
      }
    };

    return () => {
      worker.terminate();
      workerRef.current = null;
    };
  }, [months]);

  useEffect(() => {
    const requestId = activeRequestRef.current + 1;
    activeRequestRef.current = requestId;
    fiveMinuteRef.current = [];
    evidenceRef.current = null;
    setError('');
    setReplayError('');

    const cached = readAnalysisCache(months);
    if (cached) {
      evidenceRef.current = cached.evidence || null;
      setEvidence(cached.evidence || null);
      setReplay(cached.replay || null);
      setLoadStage('ready');
    } else {
      setEvidence(null);
      setReplay(null);
      setLoadStage(brokerStatus?.authenticated ? 'five' : 'idle');
    }

    if (!brokerStatus?.authenticated) return undefined;

    let cancelled = false;
    const timer = window.setTimeout(async () => {
      try {
        if (!cached) setLoadStage('five');
        const fiveResponse = await fetch('/api/fyers/research-history?months=' + months + '&resolution=5', { cache: 'no-store' });
        const fiveData = await fiveResponse.json().catch(() => ({}));
        if (!fiveResponse.ok) throw new Error(fiveData?.error || 'Historical NIFTY data could not be loaded.');
        if (cancelled || requestId !== activeRequestRef.current) return;

        const fiveMinute = Array.isArray(fiveData?.fiveMinute) ? fiveData.fiveMinute : [];
        fiveMinuteRef.current = fiveMinute;
        workerRef.current?.postMessage({ type: 'evidence', requestId, fiveMinute });

        setLoadStage('three');
        const threeResponse = await fetch('/api/fyers/research-history?months=' + months + '&resolution=3', { cache: 'no-store' });
        const threeData = await threeResponse.json().catch(() => ({}));
        if (!threeResponse.ok) throw new Error(threeData?.error || '3-minute historical NIFTY data could not be loaded.');
        if (cancelled || requestId !== activeRequestRef.current) return;

        const threeMinute = Array.isArray(threeData?.threeMinute) ? threeData.threeMinute : [];
        setLoadStage('replay');
        workerRef.current?.postMessage({
          type: 'replay',
          requestId,
          history: historyRef.current,
          fiveMinute,
          threeMinute
        });
      } catch (err) {
        if (cancelled || requestId !== activeRequestRef.current) return;
        const message = err?.message || 'Historical NIFTY data could not be loaded.';
        if (fiveMinuteRef.current.length) {
          setReplayError(message);
          setLoadStage('ready');
        } else {
          setError(message);
          setLoadStage('error');
        }
      }
    }, cached ? 900 : 80);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [months, brokerStatus?.authenticated]);

  return (
    <div className="mentor-page research-analysis-page">
      <div className="mentor-page-head research-analysis-head">
        <div>
          <div className="eyebrow">EVIDENCE LAB · READ ONLY</div>
          <h1>Research Strategy Analysis</h1>
          <p>Compare what the Mentor has actually recorded, then study the same NIFTY market context without changing either live strategy.</p>
        </div>
        <span>NO STRATEGY CHANGES</span>
      </div>

      <section className="analysis-safety-banner">
        <strong>This page observes; it does not trade.</strong>
        <p>The 13-point Mentor, Shadow Research and Scalp rules remain untouched. Any future rule change should be tested separately only after enough evidence is collected.</p>
      </section>

      <AnalysisLoadStatus
        stage={loadStage}
        months={months}
        hasEvidence={Boolean(evidence)}
        hasReplay={Boolean(replay)}
        error={error || replayError}
      />

      <section className="analysis-section">
        <div className="analysis-section-head">
          <div>
            <span>YOUR ACTUAL JOURNAL</span>
            <h2>Who opened each kind of research position?</h2>
          </div>
          <small>{Array.isArray(history) ? history.length : 0} completed records loaded</small>
        </div>

        <div className="analysis-cohort-grid">
          {cohorts.map(row => (
            <article className="analysis-cohort-card" key={row.id}>
              <div className="analysis-cohort-title">
                <span>{row.short}</span>
                <strong>{row.label}</strong>
              </div>
              <p>{row.copy}</p>
              <div className="analysis-stat-grid">
                <Stat label="Trades" value={row.stats.total} />
                <Stat label="Net P&L" value={money(row.stats.pnl)} tone={tone(row.stats.pnl)} />
                <Stat label="Win rate" value={pct(row.stats.winRate)} />
                <Stat label="Avg R" value={r(row.stats.avgR)} tone={tone(row.stats.avgR)} />
                <Stat label="Avg hold" value={minutes(row.stats.avgHold)} />
                <Stat label="Max drawdown" value={money(-row.stats.maxDrawdown)} tone={row.stats.maxDrawdown > 0 ? 'negative' : ''} />
              </div>
              <div className="analysis-cohort-foot">
                <span>Profit factor</span>
                <strong>{profitFactor(row.stats.profitFactor)}</strong>
              </div>
            </article>
          ))}
        </div>
      </section>

      <section className="analysis-section">
        <div className="analysis-section-head">
          <div>
            <span>NIFTY HISTORICAL CONTEXT</span>
            <h2>Same market, longer evidence window</h2>
          </div>
          <div className="analysis-period-control" role="group" aria-label="Historical analysis period">
            {[1, 3, 6].map(value => (
              <button
                type="button"
                key={value}
                className={months === value ? 'active' : ''}
                onClick={() => setMonths(value)}
              >
                {value}M
              </button>
            ))}
          </div>
        </div>

        {!brokerStatus?.authenticated ? (
          <div className="analysis-empty">
            <strong>Connect FYERS to load historical NIFTY candles.</strong>
            <p>The journal analysis above still works without FYERS.</p>
          </div>
        ) : error && !evidence ? (
          <div className="analysis-empty error">
            <strong>Historical data unavailable</strong>
            <p>{error}</p>
          </div>
        ) : evidence ? (
          <>
            <div className="analysis-market-grid">
              <Stat label="Sessions" value={evidence.coverage.sessions} />
              <Stat label="5m candles" value={evidence.coverage.fiveMinuteCandles.toLocaleString('en-IN')} />
              <Stat label="3m candles" value={evidence.coverage.threeMinuteCandles.toLocaleString('en-IN')} />
              <Stat label="Avg daily range" value={points(evidence.range.average)} />
              <Stat label="Median range" value={points(evidence.range.median)} />
              <Stat label="High-vol sessions" value={evidence.range.highVolSessions + ' · ' + pct(evidence.range.highVolShare)} />
              <Stat label="Trend-day proxy" value={evidence.regime.trendSessions + ' · ' + pct(evidence.regime.trendShare)} />
              <Stat label="Choppy-day proxy" value={evidence.regime.choppySessions + ' · ' + pct(evidence.regime.choppyShare)} />
            </div>

            <div className="analysis-compare-grid">
              <article>
                <span>SCHEDULED TUESDAY EXPIRY PROXY</span>
                <strong>{points(evidence.scheduledExpiryProxy.tuesdayAverageRange)} average range</strong>
                <p>{evidence.scheduledExpiryProxy.tuesdaySessions} Tuesday sessions in this dataset.</p>
              </article>
              <article>
                <span>OTHER WEEKDAYS</span>
                <strong>{points(evidence.scheduledExpiryProxy.otherAverageRange)} average range</strong>
                <p>{evidence.scheduledExpiryProxy.otherSessions} non-Tuesday sessions in this dataset.</p>
              </article>
            </div>

            <p className="analysis-method-note">
              Tuesday is shown only as a scheduled NIFTY-expiry proxy. Exchange-holiday shifts are not inferred here. Market-regime figures describe NIFTY movement; they are not trade signals.
            </p>
          </>
        ) : (
          <div className="analysis-empty">
            <strong>Loading {months} months of NIFTY evidence…</strong>
            <p>5-minute context loads first so this section can appear before the heavier replay work.</p>
          </div>
        )}
      </section>

      <section className="analysis-section">
        <div className="analysis-section-head">
          <div>
            <span>JOURNAL × EXPIRY CONTEXT</span>
            <h2>What have our recorded trades done on Tuesdays?</h2>
          </div>
        </div>
        <div className="analysis-compare-grid">
          <JournalContext title="Tuesday records" stats={expiryJournal.tuesday} />
          <JournalContext title="Other weekdays" stats={expiryJournal.other} />
        </div>
        <p className="analysis-method-note">This becomes meaningful only after enough recorded trades exist. A few trades can look excellent or poor purely by chance.</p>
      </section>

      <section className="analysis-section replay-lab-section">
        <div className="analysis-section-head">
          <div>
            <span>STAGE 2 · SAME-ENTRY COUNTERFACTUAL</span>
            <h2>What if the same recorded entry used a different exit manager?</h2>
          </div>
          <small>R-based · NIFTY path only</small>
        </div>

        {!brokerStatus?.authenticated ? (
          <div className="analysis-empty">
            <strong>Connect FYERS to run Stage 2.</strong>
            <p>The Replay Lab needs historical NIFTY candles after each recorded entry.</p>
          </div>
        ) : replayError && !replay ? (
          <div className="analysis-empty error">
            <strong>Replay calculation unavailable</strong>
            <p>{replayError}</p>
          </div>
        ) : replay ? (
          <>
            <div className="replay-model-grid">
              <ReplayModelCard
                definition={REPLAY_MODELS.find(row => row.id === 'actual')}
                stats={replay.journal.summaries.actualCore}
                note={replay.journal.coreCases + ' matched 13-point / Shadow / Legacy records'}
              />
              <ReplayModelCard
                definition={REPLAY_MODELS.find(row => row.id === 'legacy')}
                stats={replay.journal.summaries.legacy}
              />
              <ReplayModelCard
                definition={REPLAY_MODELS.find(row => row.id === 'runner')}
                stats={replay.journal.summaries.runner}
              />
              <ReplayModelCard
                definition={REPLAY_MODELS.find(row => row.id === 'shadow')}
                stats={replay.journal.summaries.shadow}
              />
            </div>

            <div className="replay-head-to-head">
              <div>
                <span>LEGACY vs CURRENT RUNNER</span>
                <strong>{replay.journal.legacyVsRunner.matched} matched entries</strong>
              </div>
              <div><span>Legacy finished higher</span><strong>{replay.journal.legacyVsRunner.leftBetter}</strong></div>
              <div><span>Runner finished higher</span><strong>{replay.journal.legacyVsRunner.rightBetter}</strong></div>
              <div><span>Near equal</span><strong>{replay.journal.legacyVsRunner.equal}</strong></div>
              <div><span>Legacy average difference</span><strong className={tone(replay.journal.legacyVsRunner.avgDifferenceR)}>{r(replay.journal.legacyVsRunner.avgDifferenceR)}</strong></div>
            </div>

            <div className="replay-scalp-strip">
              <ReplayModelCard
                definition={{ ...REPLAY_MODELS.find(row => row.id === 'actual'), label: 'Recorded Scalp outcome', short: 'Scalp actual' }}
                stats={replay.journal.summaries.actualScalp}
                note={replay.journal.scalpCases + ' matched scalp records'}
              />
              <ReplayModelCard
                definition={REPLAY_MODELS.find(row => row.id === 'scalp')}
                stats={replay.journal.summaries.scalp}
              />
            </div>

            <ReplayCaseTable rows={replay.journal.cases.slice(-12).reverse()} />

            <p className="analysis-method-note">
              This comparison holds the entry and structural stop constant. Legacy and Shadow target/stop paths can be replayed directly from NIFTY candles. The current runner card is intentionally marked as a path proxy because historical live-bias and score deterioration are not available for every old candle.
            </p>
          </>
        ) : (
          <div className="analysis-empty">
            <strong>{loadStage === 'three' ? 'Loading 3-minute replay data…' : loadStage === 'replay' ? 'Calculating Replay Lab in the background…' : 'Preparing Replay Lab…'}</strong>
            <p>The calculation runs outside the main app thread, so Mentor remains responsive while this finishes.</p>
          </div>
        )}
      </section>

      <section className="analysis-section replay-lab-section">
        <div className="analysis-section-head">
          <div>
            <span>STAGE 2 · SIX-MONTH STRUCTURAL SCAN</span>
            <h2>How did comparable NIFTY structures behave across the historical window?</h2>
          </div>
          <small>{replay ? replay.coverage.from + ' → ' + replay.coverage.to : ''}</small>
        </div>

        {replay ? (
          <>
            <div className="replay-model-grid structural-probe-grid">
              {STRUCTURE_PROBES.map(definition => {
                const probe = replay.structural.probes[definition.id];
                return (
                  <ReplayModelCard
                    key={definition.id}
                    definition={{ ...definition, integrity: 'NIFTY-only probe' }}
                    stats={probe?.stats}
                  />
                );
              })}
            </div>

            <div className="replay-expiry-grid">
              {STRUCTURE_PROBES.map(definition => {
                const split = replay.structural.tuesday[definition.id];
                return (
                  <article key={definition.id}>
                    <span>{definition.short.toUpperCase()}</span>
                    <strong>Tuesday {r(split?.tuesday?.avgR || 0)} avg R</strong>
                    <p>{split?.tuesday?.total || 0} Tuesday probes · {pct(split?.tuesday?.winRate || 0)} positive</p>
                    <strong>Other days {r(split?.other?.avgR || 0)} avg R</strong>
                    <p>{split?.other?.total || 0} other-day probes · {pct(split?.other?.winRate || 0)} positive</p>
                  </article>
                );
              })}
            </div>

            <p className="analysis-method-note">
              These are deliberately called structural probes, not exact strategy trades. They use only information available from historical NIFTY candles and never fabricate historical option liquidity, Greeks, PCR or option-chain state. Their purpose is to test whether the underlying market structure itself repeatedly carried an edge.
            </p>
          </>
        ) : (
          <div className="analysis-empty"><strong>Historical replay waits for the NIFTY dataset.</strong></div>
        )}
      </section>

      <section className="analysis-section analysis-integrity">
        <div className="analysis-section-head">
          <div>
            <span>REPLAY INTEGRITY</span>
            <h2>What we will and will not call a six-month backtest</h2>
          </div>
        </div>
        <div className="analysis-integrity-grid">
          <article className="pass">
            <strong>Evidence we can use now</strong>
            <p>Actual Trade Journal outcomes, exact recorded entry/exit metadata, 3-minute NIFTY candles, 5-minute NIFTY candles, session range and regime comparisons.</p>
          </article>
          <article className="caution">
            <strong>Evidence still required for exact strategy replay</strong>
            <p>Point-in-time option chain, bid/ask, liquidity, Greeks and the option contract that would have been selected at every historical entry. The app will not substitute today’s option chain and pretend the result is historical.</p>
          </article>
        </div>
        <p className="analysis-method-note">
          That distinction protects us from improving a strategy on fabricated hindsight. Historical NIFTY context is useful now; exact option-strategy replay should only be labelled complete when the required point-in-time option evidence is available.
        </p>
      </section>
    </div>
  );
}

function AnalysisLoadStatus({ stage, months, hasEvidence, hasReplay, error }) {
  const ready = hasEvidence && hasReplay;
  const label = error
    ? 'PARTIAL DATA'
    : ready
      ? 'ANALYSIS READY'
      : stage === 'five'
        ? 'LOADING 5M CONTEXT'
        : stage === 'three'
          ? 'LOADING 3M REPLAY DATA'
          : stage === 'replay'
            ? 'CALCULATING REPLAY'
            : 'READY TO LOAD';

  return (
    <div className={'analysis-load-status ' + (ready ? 'ready' : error ? 'warning' : 'working')}>
      <span className="analysis-load-dot" />
      <div>
        <strong>{label}</strong>
        <small>{ready ? months + '-month evidence is cached for fast reopening.' : error || 'The page stays usable while historical work continues in the background.'}</small>
      </div>
    </div>
  );
}

function ReplayModelCard({ definition, stats, note = '' }) {
  if (!definition) return null;
  const safe = stats || { total: 0, winRate: 0, avgR: 0, totalR: 0, maxDrawdownR: 0, avgHold: 0, exits: {} };

  return (
    <article className="replay-model-card">
      <div className="replay-model-title">
        <div><span>{definition.short || definition.label}</span><strong>{definition.label}</strong></div>
        <em>{definition.integrity || 'Replay'}</em>
      </div>
      <p>{definition.copy}</p>
      <div className="analysis-stat-grid">
        <Stat label="Cases" value={safe.total || 0} />
        <Stat label="Positive" value={pct(safe.winRate || 0)} />
        <Stat label="Avg R" value={r(safe.avgR || 0)} tone={tone(safe.avgR || 0)} />
        <Stat label="Total R" value={r(safe.totalR || 0)} tone={tone(safe.totalR || 0)} />
        <Stat label="Max DD" value={r(-(safe.maxDrawdownR || 0))} tone={safe.maxDrawdownR > 0 ? 'negative' : ''} />
        <Stat label="Avg hold" value={minutes(safe.avgHold || 0)} />
      </div>
      <div className="replay-exit-row">
        <span>Stops {safe.exits?.stop || 0}</span>
        <span>Targets {safe.exits?.target || 0}</span>
        <span>Time {safe.exits?.time || 0}</span>
        <span>Protect {safe.exits?.protect || 0}</span>
      </div>
      {note && <small className="replay-card-note">{note}</small>}
    </article>
  );
}

function ReplayCaseTable({ rows }) {
  if (!rows?.length) {
    return <div className="analysis-empty replay-case-empty"><strong>No journal entries could be aligned to the selected historical period yet.</strong></div>;
  }

  return (
    <div className="replay-case-wrap">
      <div className="replay-case-title"><span>RECENT MATCHED ENTRIES</span><strong>Same entry · different management</strong></div>
      <div className="replay-case-scroll">
        <table className="replay-case-table">
          <thead>
            <tr><th>Entry</th><th>Type</th><th>Actual</th><th>Legacy</th><th>Runner</th><th>Shadow</th><th>Scalp</th></tr>
          </thead>
          <tbody>
            {rows.map(row => (
              <tr key={row.id}>
                <td><strong>{row.side}</strong><small>{shortDate(row.openedAt)}</small></td>
                <td>{cohortLabel(row.cohort)}</td>
                <ReplayCell result={row.models.actual} />
                <ReplayCell result={row.models.legacy} />
                <ReplayCell result={row.models.runner} />
                <ReplayCell result={row.models.shadow} />
                <ReplayCell result={row.models.scalp} />
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function ReplayCell({ result }) {
  if (!result) return <td className="muted">—</td>;
  return (
    <td className={tone(result.r)}>
      <strong>{r(result.r)}</strong>
      <small>{replayReason(result.exitReason)}</small>
    </td>
  );
}

function replayReason(value) {
  const code = String(value || '');
  if (code.includes('STOP')) return 'Stop';
  if (code.includes('TARGET')) return 'Target';
  if (code.includes('GIVEBACK')) return 'Protect';
  if (code.includes('TIME')) return 'Time';
  if (code.includes('SESSION')) return 'Session';
  return 'Recorded';
}

function cohortLabel(value) {
  const labels = {
    LEGACY: 'Legacy',
    SHADOW: 'Shadow',
    CORE_AUTO: '13pt Auto',
    CORE_MANUAL: '13pt Manual',
    SCALP_AUTO: 'Scalp Auto',
    SCALP_MANUAL: 'Scalp Manual'
  };
  return labels[value] || value || 'Research';
}

function shortDate(value) {
  const date = new Date(value || 0);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleString('en-IN', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
}

function JournalContext({ title, stats }) {
  return (
    <article>
      <span>{title.toUpperCase()}</span>
      <strong>{stats.total} trades · {pct(stats.winRate)} wins</strong>
      <p>{money(stats.pnl)} net P&amp;L · {r(stats.avgR)} average R · {money(-stats.maxDrawdown)} max drawdown</p>
    </article>
  );
}

function Stat({ label, value, tone: valueTone = '' }) {
  return <div className={'analysis-stat ' + valueTone}><span>{label}</span><strong>{value}</strong></div>;
}

function money(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return '—';
  return (number < 0 ? '-' : '') + '₹' + Math.abs(number).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function points(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number.toLocaleString('en-IN', { maximumFractionDigits: 1 }) + ' pts' : '—';
}

function pct(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number.toFixed(0) + '%' : '—';
}

function r(value) {
  const number = Number(value);
  return Number.isFinite(number) ? (number >= 0 ? '+' : '') + number.toFixed(2) + 'R' : '—';
}

function minutes(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.round(number) + ' min' : '—';
}

function tone(value) {
  const number = Number(value);
  return number > 0 ? 'positive' : number < 0 ? 'negative' : '';
}

function profitFactor(value) {
  if (value === Infinity) return '∞';
  const number = Number(value);
  return Number.isFinite(number) ? number.toFixed(2) : '—';
}


const ANALYSIS_CACHE_PREFIX = 'index-options-mentor-analysis-v42-';
const ANALYSIS_CACHE_TTL_MS = 10 * 60 * 1000;

function readAnalysisCache(months) {
  try {
    const raw = sessionStorage.getItem(ANALYSIS_CACHE_PREFIX + months);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed?.savedAt || Date.now() - parsed.savedAt > ANALYSIS_CACHE_TTL_MS) {
      sessionStorage.removeItem(ANALYSIS_CACHE_PREFIX + months);
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

function writeAnalysisCache(months, value) {
  try {
    sessionStorage.setItem(ANALYSIS_CACHE_PREFIX + months, JSON.stringify(value));
  } catch {}
}
