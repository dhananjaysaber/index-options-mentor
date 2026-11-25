import ExecutionConnectionPanel from './ExecutionConnectionPanel.jsx';
import { useEffect, useState } from 'react';

export default function SettingsPanel({ settings, onSave }) {
  const [draft, setDraft] = useState(settings);
  const [saved, setSaved] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => setDraft(settings), [settings]);

  function update(key, value) {
    setSaved(false);
    setDraft(current => ({ ...current, [key]: value }));
  }

  function save() {
    if (saving) return;
    const clean = {
      ...draft,
      capital: Math.max(10000, Number(draft.capital) || 50000),
      riskPct: Math.max(0.1, Math.min(10, Number(draft.riskPct) || 1)),
      defaultLots: Math.max(1, Math.min(20, Math.round(Number(draft.defaultLots) || 1))),
      lotCap: Math.max(1, Math.min(20, Math.round(Number(draft.lotCap) || 5)))
    };
    if (clean.defaultLots > clean.lotCap) clean.defaultLots = clean.lotCap;

    setSaving(true);
    setSaved(false);
    onSave(clean);
    setDraft(clean);

    window.setTimeout(() => {
      setSaving(false);
      setSaved(true);
    }, 550);
  }

  return (
    <section className="settings-page panel">
      <div className="settings-hero">
        <div>
          <div className="eyebrow">MENTOR CONTROL</div>
          <h1>Settings</h1>
          <p>Account sizing and simulation automation live here. Strategy thresholds remain locked in the Mentor engine so normal settings changes cannot quietly weaken the 13-step model.</p>
        </div>
        <span className={`settings-save-state ${saving ? 'saving' : saved ? 'success' : ''}`} aria-live="polite">
          {saving ? 'Saving settings…' : saved ? 'Settings saved successfully' : 'Changes not saved'}
        </span>
      </div>

      <ExecutionConnectionPanel />

      <div className="settings-grid">
        <SettingsCard title="Account & sizing" copy="Used for risk analysis and research sizing. The exchange contract lot size still comes directly from FYERS.">
          <Field label="Capital" hint="Your working capital for risk calculations.">
            <input type="number" min="10000" step="5000" value={draft.capital} onChange={e => update('capital', e.target.value)} />
          </Field>
          <Field label="Risk %" hint="Used to show whether a simulated setup would fit your intended real-risk budget.">
            <input type="number" min="0.1" max="10" step="0.1" value={draft.riskPct} onChange={e => update('riskPct', e.target.value)} />
          </Field>
          <Field label="Default lots" hint="Number of option lots used when you or the Mentor opens a research simulation.">
            <input type="number" min="1" max="20" value={draft.defaultLots} onChange={e => update('defaultLots', e.target.value)} />
          </Field>
          <Field label="Maximum lots" hint="Safety ceiling for simulation sizing.">
            <input type="number" min="1" max="20" value={draft.lotCap} onChange={e => update('lotCap', e.target.value)} />
          </Field>
          <div className="settings-note"><strong>Important:</strong> NIFTY contract lot size is exchange-defined and is read from FYERS. “Default lots” means how many contracts the simulation uses; it does not alter the exchange lot size.</div>
        </SettingsCard>

        <SettingsCard title="Mentor automation" copy="These switches control simulated research positions only. They do not place real FYERS orders.">
          <Toggle checked={draft.mentorAutoOpen} onChange={value => update('mentorAutoOpen', value)} title="Mentor auto-open" copy="Open an eligible simulated setup automatically so missed screen taps do not create missing research data." />
          <Toggle checked={draft.mentorAutoClose} onChange={value => update('mentorAutoClose', value)} title="Mentor auto-close" copy="Close the 13-point simulated position automatically when the position Mentor reaches a genuine EXIT condition." />
          <Toggle checked={draft.scalpAutoOpen !== false} onChange={value => update('scalpAutoOpen', value)} title="Scalp auto-open" copy="Open a scalp simulation automatically only when the strict 5m-context / 3m-execution scalp rules qualify." />
          <Toggle checked={draft.scalpAutoClose !== false} onChange={value => update('scalpAutoClose', value)} title="Scalp auto-close" copy="Auto-close scalp simulations on +1R target, hard stop, time limit, context failure or profit-protection exit. Applies to both auto and manually opened scalp positions." />
          <Toggle checked={draft.controlledResearch} onChange={value => update('controlledResearch', value)} title="4/5 controlled research" copy="Track 4/5 mandatory + at least 7/8 confirmation setups when hard safety gates still pass." />
          <Toggle checked={draft.experimentalResearch} onChange={value => update('experimentalResearch', value)} title="3/5 experimental research" copy="Track 3/5 mandatory + at least 6/8 confirmation setups when hard safety gates still pass. Research only." />
        </SettingsCard>

        <SettingsCard title="FYERS live handoff" copy="Prepare the Mentor's current order plan for manual review in FYERS. No broker order is submitted from this PWA.">
          <Toggle checked={draft.liveHandoffEnabled !== false} onChange={value => update('liveHandoffEnabled', value)} title="Show live handoff" copy="Show the current symbol, lots, quantity, reference price, NIFTY stop and target with Copy Plan and Open FYERS actions." />
          <div className="settings-note"><strong>Execution boundary:</strong> the Mentor can prepare and validate the order plan, but placing, modifying and cancelling a real FYERS order remains a separate confirmation inside FYERS.</div>
        </SettingsCard>

        <SettingsCard title="What stays non-negotiable" copy="Automation does not override these protections.">
          <div className="locked-rules">
            <span>Live regular-session data</span>
            <span>Completed 5-minute confirmation</span>
            <span>Retest held</span>
            <span>Defined structural invalidation</span>
            <span>Risk / entry freshness gate</span>
            <span>Option liquidity gate</span>
            <span>R:R at least 1:1</span>
            <span>Confluence at least 80 for research positions</span>
          </div>
        </SettingsCard>
      </div>

      <div className="settings-actions">
        <button type="button" className={`settings-save-btn ${saving ? 'is-saving' : saved ? 'is-saved' : ''}`} onClick={save} disabled={saving}>
          {saving && <span className="settings-save-spinner" aria-hidden="true" />}
          <span>{saving ? 'Saving…' : saved ? 'Saved' : 'Save settings'}</span>
        </button>
        <span className={saved ? 'settings-success-copy' : ''}>{saved ? 'Settings saved successfully and are now active on this device.' : 'Saved locally and used immediately by the Mentor on this device.'}</span>
      </div>
    </section>
  );
}

function SettingsCard({ title, copy, children }) {
  return (
    <article className="settings-card">
      <div className="settings-card-head"><h2>{title}</h2><p>{copy}</p></div>
      <div className="settings-card-body">{children}</div>
    </article>
  );
}

function Field({ label, hint, children }) {
  return (
    <label className="settings-field">
      <span><strong>{label}</strong><small>{hint}</small></span>
      {children}
    </label>
  );
}

function Toggle({ checked, onChange, title, copy }) {
  return (
    <label className="settings-toggle-row">
      <span><strong>{title}</strong><small>{copy}</small></span>
      <input type="checkbox" checked={Boolean(checked)} onChange={e => onChange(e.target.checked)} />
      <i aria-hidden="true" />
    </label>
  );
}
