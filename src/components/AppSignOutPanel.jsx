import { useRef, useState } from 'react';
import { signOut } from '../services/appSignIn.js';
import './TradingSetup.css';

export default function AppSignOutPanel() {
  const [message, setMessage] = useState('');
  const busy = useRef(false);
  async function leave(allDevices) {
    if (busy.current) return;
    busy.current = true; setMessage('Signing out…');
    try { await signOut(window.fetch.bind(window), allDevices); window.location.reload(); }
    catch {
      busy.current = false;
      setMessage(allDevices ? 'Sign out of all devices could not be confirmed. Try again.' : 'Sign out could not be confirmed. Try again.');
    }
  }
  return <section className="settings-card live-setup-card" aria-label="App sign-in">
    <span className="live-setup-eyebrow">APP SIGN-IN</span>
    <h3>Signed in with Google</h3>
    <p>Signing out does not close trades or stop your server’s automatic buying. Use “Pause new real entries” to stop new buys.</p>
    <div className="live-setup-actions">
      <button className="live-setup-button" type="button" onClick={() => leave(false)}>Sign out</button>
      <button className="live-setup-button live-setup-exit" type="button" onClick={() => leave(true)}>Sign out all devices</button>
    </div>
    {message && <p role="status">{message}</p>}
  </section>;
}
