import { useEffect, useMemo, useState } from 'react';
import {
  analyseExpiryProxy,
  buildCohortAnalysis,
  buildMarketEvidence
} from '../services/researchAnalysis.js';

export default function ResearchAnalysis({ history, brokerStatus }) {
  const [months, setMonths] = useState(6);
  const [marketData, setMarketData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const cohorts = useMemo(() => buildCohortAnalysis(history), [history]);
  const expiryJournal = useMemo(() => analyseExpiryProxy(history), [history]);
  const evidence = useMemo(
    () => marketData ? buildMarketEvidence(marketData.fiveMinute, marketData.threeMinute) : null,
    [marketData]
  );

  useEffect(() => {
    if (!brokerStatus?.authenticated) {
      setMarketData(null);
      return undefined;
    }

    let cancelled = false;
    const load = async () => {
      setLoading(true);
      setError('');
      try {
        const response = await fetch('/api/fyers/research-history?months=' + months, { cache: 'no-store' });
        const data = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(data?.error || 'Historical NIFTY data could not be loaded.');
        if (!cancelled) setMarketData(data);
      } catch (err) {
        if (!cancelled) {
          setMarketData(null);
          setError(err?.message || 'Historical NIFTY data could not be loaded.');
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    void load();
    return () => { cancelled = true; };
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
        ) : loading ? (
          <div className="analysis-empty">
            <strong>Loading {months} months of NIFTY evidence…</strong>
            <p>Fetching 5-minute and 3-minute candles in safe date chunks.</p>
          </div>
        ) : error ? (
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
        ) : null}
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
