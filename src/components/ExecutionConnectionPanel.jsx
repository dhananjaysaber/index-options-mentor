import { useState } from 'react';
export default function ExecutionConnectionPanel(){
  const [busy,setBusy]=useState(false),[result,setResult]=useState(null),[error,setError]=useState('');
  async function check(){
    if(busy)return;setBusy(true);setError('');setResult(null);
    try{
      const response=await fetch('/api/execution/check',{method:'POST',headers:{'content-type':'application/json','x-iom-action':'execution-check'},body:JSON.stringify({checkId:crypto.randomUUID()})});
      const data=await response.json();
      if(!response.ok){const messages={FYERS_SESSION_REQUIRED:'Connect FYERS first, then run this check.',FYERS_ACCOUNT_NOT_VERIFIED:'FYERS could not verify your account. Reconnect and try again.',FYERS_ACCOUNT_NOT_EXECUTION_OWNER:'This FYERS account does not match the AWS owner.'};throw Error(messages[data.error]||'The AWS execution-check service is not connected yet. Real-money trading remains off.');}
      if(data.realMoneyEnabled!==false||!Array.isArray(data.checks)||data.checks.length!==2||!data.checks.every(row=>row.passed===true&&row.journalRows===1&&row.replayCreatedOrders===0))throw Error('The execution check did not pass. Real-money trading remains off.');
      setResult(data);
    }catch(e){setError(e.message||'The execution check could not finish.');}finally{setBusy(false);}
  }
  return <details className="settings-card live-setup-card live-paper-check">
    <summary><span><strong>Practice-mode system check</strong><small>Optional · tests paper trades only</small></span><span className="live-setup-badge">{result ? 'Passed' : 'Not checked'}</span></summary>
    <p>Checks the practice-trade exit rules using dummy orders. It does not place real trades or change your trade history.</p>
    <button type="button" className="live-setup-button" disabled={busy} onClick={check}>{busy ? 'Checking…' : 'Run practice check'}</button>
    <div aria-live="polite">{result && <p className="live-setup-success">Practice checks passed for 13-point and Scalp. Each exit was recorded once. No real orders were sent.</p>}</div>
    {error && <p className="live-setup-error" role="alert">{error}</p>}
  </details>;
}

