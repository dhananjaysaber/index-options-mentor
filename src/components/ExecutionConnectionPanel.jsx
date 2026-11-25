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
  return <section className="settings-card" aria-label="AWS execution connection">
    <h2>AWS execution connection</h2>
    <p>This check uses simulated broker orders.</p>
    <p>Check Core and Scalp exits, stop handling and duplicate protection with fake orders. Your positions and trade history are not changed.</p>
    <button type="button" className="settings-save-btn" disabled={busy} onClick={check}>{busy?'Checking AWS…':'Check AWS connection and exits'}</button>
    <div aria-live="polite">{result&&<p>AWS connected. Core and Scalp checks passed; each exit was recorded once. The check did not send real orders.</p>}</div>
    {error&&<p role="alert">{error}</p>}
  </section>;
}
