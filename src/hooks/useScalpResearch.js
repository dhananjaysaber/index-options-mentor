import { useEffect, useMemo, useState } from 'react';
import { FYERS_REFRESH, isNseMarketHours } from '../services/fyersRefreshPolicy.js';
import { evaluateScalpSetup } from '../engine/scalpStrategy.js';

// Runs once from the parent app so Scalp monitoring is independent of
// whether the Scalp tab/chart is mounted. Uses the existing /history API.
export function useScalpResearch({ snapshot, liveQuote, brokerAuthenticated, marketDataReady, clock }) {
  const sessionDate = snapshot?.market?.sessionDate || '';
  const [candles, setCandles] = useState([]);
  const [candleLoading, setCandleLoading] = useState(false);
  const [candleError, setCandleError] = useState('');
  const [lastCandlesAt, setLastCandlesAt] = useState(0);

  useEffect(() => {
    if (!brokerAuthenticated || !sessionDate) {
      setCandles([]);
      setLastCandlesAt(0);
      return undefined;
    }
    let cancelled = false;
    let inFlight = false;
    let request = null;
    const load = async () => {
      if (cancelled || inFlight || document.visibilityState !== 'visible') return;
      inFlight = true;
      setCandleLoading(current => current || lastCandlesAt === 0);
      const controller = new AbortController();
      request = controller;
      try {
        const params = new URLSearchParams({
          symbol: 'NSE:NIFTY50-INDEX', resolution: '3',
          from: sessionDate, to: sessionDate
        });
        const response = await fetch('/api/fyers/history?' + params, {
          cache: 'no-store', signal: AbortSignal.any([
            controller.signal, AbortSignal.timeout(5000)
          ])
        });
        if (!response.ok) throw new Error(response.status === 429
          ? 'FYERS temporarily rejected 3-minute candles; retrying on the next refresh.'
          : 'FYERS 3-minute candles are not currently available.');
        const body = await response.json();
        if (!Array.isArray(body?.candles)) throw new Error('FYERS returned no valid candle history.');
        if (!cancelled) {
          setCandles(body.candles);
          setLastCandlesAt(Date.now());
          setCandleError(body.candles.length ? '' : 'Waiting for completed 3-minute candles.');
        }
      } catch (error) {
        if (!cancelled && error?.name !== 'AbortError') {
          setCandleError(error?.message || 'Could not refresh completed 3-minute candles.');
        }
      } finally {
        inFlight = false;
        if (request === controller) request = null;
        if (!cancelled) setCandleLoading(false);
      }
    };
    void load();
    const timer = window.setInterval(() => {
      if (isNseMarketHours()) void load();
    }, FYERS_REFRESH.scalpCandlesMs);
    const resume = () => {
      if (document.visibilityState === 'visible') void load();
    };
    document.addEventListener('visibilitychange', resume);
    return () => {
      cancelled = true;
      request?.abort();
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', resume);
    };
  }, [brokerAuthenticated, sessionDate]);

  const liveSpot = Number(liveQuote?.nifty) > 0
    ? Number(liveQuote.nifty) : Number(snapshot?.market?.spot);

  const quoteAt = Date.parse(liveQuote?.at || '');
  const candlesFresh = lastCandlesAt > 0 && clock - lastCandlesAt <= 12000;
  const quoteFresh = Number.isFinite(quoteAt) && clock - quoteAt >= -2000 && clock - quoteAt <= 5000;
  const ready = Boolean(marketDataReady && candlesFresh && quoteFresh && candles.length > 0);
  const evaluation = useMemo(() => {
    const result = evaluateScalpSetup(snapshot, candles, liveSpot, clock);
    if (ready) return result;
    return {
      ...result, eligible: false, manualEligible: false,
      reason: !marketDataReady ? 'Waiting for a fresh FYERS Mentor snapshot before a new scalp.'
        : !quoteFresh ? 'Waiting for a fresh live NIFTY quote.'
          : !candlesFresh ? 'Waiting for up-to-date 3-minute candle history.'
            : 'Waiting for completed 3-minute candles.',
      manualReason: 'New scalp research entries are paused until fresh market data is verified.'
    };
  }, [snapshot, candles, liveSpot, ready, marketDataReady, quoteFresh, candlesFresh, clock]);

  return { candles, candleLoading, candleError, evaluation, lastCandlesAt, quoteFresh, candlesFresh };
}
