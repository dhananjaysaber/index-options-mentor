import { useEffect, useRef, useState } from 'react';
import { MAIN_ADDRESS } from '../services/appSignIn.js';
import './SignInScreen.css';

const GOOGLE_SCRIPT = 'https://accounts.google.com/gsi/client';
const NONCE_REFRESH_MS = 9 * 60 * 1000;

function loadGoogle() {
  if (window.google?.accounts?.id) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = GOOGLE_SCRIPT; script.async = true;
    script.onload = resolve;
    script.onerror = () => { script.remove(); reject(new Error('GOOGLE_NOT_LOADED')); };
    document.head.appendChild(script);
  });
}

// Nothing else of the app is loaded behind this screen.
export default function SignInScreen({ state }) {
  const button = useRef(null);
  const [message, setMessage] = useState('');
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (state !== 'signed-out') return undefined;
    let live = true;
    const timer = window.setTimeout(() => setAttempt(value => value + 1), NONCE_REFRESH_MS);
    async function signIn(credential) {
      setMessage('Signing in…');
      try {
        const response = await fetch('/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json', 'x-iom-action': 'app-sign-in' }, body: JSON.stringify({ credential }) });
        const data = await response.json();
        if (response.ok && data.signedIn) { window.location.reload(); return; }
        setMessage(data.error === 'ACCOUNT_NOT_ALLOWED' ? 'This Google account is not allowed. Use your personal account.' : 'Sign-in could not be confirmed. Please try again.');
      } catch { setMessage('Sign-in could not be confirmed. Check your connection and try again.'); }
      if (live) setAttempt(value => value + 1);
    }
    (async () => {
      try {
        const settings = await (await fetch('/api/auth/config', { cache: 'no-store' })).json();
        if (!settings.configured) { if (live) setMessage('Sign-in has not been set up on the server yet.'); return; }
        await loadGoogle();
        if (!live || !button.current) return;
        window.google.accounts.id.initialize({ client_id: settings.clientId, nonce: settings.nonce, auto_select: false, callback: result => signIn(result.credential) });
        button.current.replaceChildren();
        window.google.accounts.id.renderButton(button.current, { theme: 'filled_blue', size: 'large', text: 'signin_with', shape: 'pill', width: 260 });
      } catch { if (live) setMessage('Google sign-in could not load. Check your connection and try again.'); }
    })();
    return () => { live = false; window.clearTimeout(timer); };
  }, [state, attempt]);

  return <main className="app-sign-in">
    <section className="app-sign-in-card">
      <span className="app-sign-in-eyebrow">PRIVATE APP</span>
      <h1>Index Options Mentor</h1>
      {state === 'signed-out' && <>
        <p>Sign in with your personal Google account. You sign in once each day.</p>
        <div className="app-sign-in-google" ref={button} />
      </>}
      {state === 'wrong-address' && <>
        <p>This copy of the app is closed. Open the app at its main address.</p>
        <a className="app-sign-in-action" href={MAIN_ADDRESS}>optionsmentor.netlify.app</a>
      </>}
      {state === 'not-configured' && <p>Sign-in has not been set up on the server yet, so the app stays locked.</p>}
      {state === 'unavailable' && <>
        <p>Your sign-in could not be checked. The app stays locked until it can. For an open trade, use the FYERS app.</p>
        <button className="app-sign-in-action" type="button" onClick={() => window.location.reload()}>Try again</button>
      </>}
      {message && <p role="status">{message}</p>}
    </section>
  </main>;
}
