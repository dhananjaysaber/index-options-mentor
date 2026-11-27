import { useEffect, useState } from 'react';
import { RETURN_PATH, finishTradingLogin, returnedValues } from '../services/tradingLogin.js';
import './SignInScreen.css';

let sent = null; // The one-time code is sent once, whatever React does.

export default function TradingLoginReturn() {
  const [result, setResult] = useState({ kind: 'sending', message: 'Checking your FYERS sign-in with your server…' });
  useEffect(() => {
    if (!sent) {
      const values = returnedValues(window.location.search);
      // Remove the one-time code from the address bar and history.
      window.history.replaceState({}, document.title, RETURN_PATH);
      sent = finishTradingLogin((url, init) => fetch(url, init), values);
    }
    sent.then(() => setResult({ kind: 'done', message: 'Trading account connected. Your server is restarting its connection. Wait a few seconds, then check the trading connection.' }),
      error => setResult({ kind: 'failed', message: error.message }));
  }, []);
  return <main className="app-sign-in">
    <section className="app-sign-in-card">
      <span className="app-sign-in-eyebrow">TRADING ACCOUNT</span>
      <h1>{result.kind === 'done' ? 'Connected' : result.kind === 'failed' ? 'Not connected' : 'Connecting…'}</h1>
      <p role={result.kind === 'failed' ? 'alert' : 'status'}>{result.message}</p>
      {result.kind !== 'sending' && <a className="app-sign-in-action" href="/">Open the app</a>}
    </section>
  </main>;
}
