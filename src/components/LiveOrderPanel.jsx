import {useRef,useState} from 'react';
export default function LiveOrderPanel({tradeAmount}){
  const [status,setStatus]=useState(null),[plan,setPlan]=useState(null),[busy,setBusy]=useState(false),[error,setError]=useState('');
  const pending=useRef(null);
  const money=n=>new Intl.NumberFormat('en-IN',{style:'currency',currency:'INR'}).format(n);
  async function api(action,payload){
    const r=await fetch('/api/orders/'+action,action==='status'?{}:{method:'POST',headers:{'content-type':'application/json','x-iom-action':'live-orders'},body:JSON.stringify(payload)});
    const data=await r.json();
    if(!r.ok){const messages={FYERS_SESSION_REQUIRED:'Connect FYERS in this preview first.',FYERS_ACCOUNT_NOT_VERIFIED:'FYERS could not verify this login.',ACCOUNT_DOES_NOT_MATCH_AWS:'This account does not match the saved AWS owner.',ORDER_NOT_ACCEPTED_CHECK_STATUS:'The order was not accepted. Check connection and broker status before trying again.'};throw Error(messages[data.error]||'The order service could not be reached. Check the broker before retrying an order.');}
    return data;
  }
  async function run(fn){if(busy)return;setBusy(true);setError('');try{await fn();}catch(e){setError(e.message);}finally{setBusy(false);}}
  async function refresh(){setStatus(await api('status'));}
  async function prepare(strategy){
    setPlan(null);await api('settings',{settings:{tradeAmount:Number(tradeAmount)}});
    if(!pending.current||pending.current.strategy!==strategy||Date.now()-pending.current.at>15000)pending.current={strategy,id:crypto.randomUUID(),at:Date.now()};
    const r=await api('prepare',{intentId:pending.current.id,strategy});setPlan(r.plan);await refresh();
  }
  async function submit(){await api('submit',{intentId:plan.intentId});setPlan(null);await refresh();}
  return <section className="settings-card" aria-label="Real-money order connection">
    <h2>Real-money order connection</h2>
    <p>{status?.realMoneyEnabled?'Real-money sending is enabled on AWS.':'Real-money sending is OFF.'}</p>
    <p>Mentor selects the strike. Your amount per trade is {money(Number(tradeAmount)||0)}. The order plan shows the live buy price and whole lots before submission.</p>
    <button type="button" disabled={busy} onClick={()=>run(refresh)}>Check trading connection</button>
    {status&&<div aria-live="polite"><p>AWS order service connected. {status.attentionRequired?'A position needs attention; check FYERS.':'No position alerts reported.'}</p>
      <p>Actual broker stop/exit acceptance: {status.actualBrokerAcceptanceVerified?'verified':'not yet verified'}.</p>
      <label><input type="checkbox" checked={Boolean(status.settings?.mentorAutoOpen)} disabled={busy||!status.realMoneyEnabled} onChange={e=>{const checked=e.target.checked;run(async()=>{await api('settings',{settings:{mentorAutoOpen:checked}});await refresh();});}} /> Live 13-point auto-entry</label>
      <label><input type="checkbox" checked={Boolean(status.settings?.scalpAutoOpen)} disabled={busy||!status.realMoneyEnabled} onChange={e=>{const checked=e.target.checked;run(async()=>{await api('settings',{settings:{scalpAutoOpen:checked}});await refresh();});}} /> Live Scalp auto-entry</label>
      <button type="button" disabled={busy} onClick={()=>run(()=>prepare('CORE'))}>Prepare 13-point plan</button>
      <button type="button" disabled={busy} onClick={()=>run(()=>prepare('SCALP'))}>Prepare Scalp plan</button>
      {status.positions?.map(p=><div key={p.id}><p>{p.strategy} · {p.symbol} · {p.state}</p><button type="button" disabled={busy||!status.realMoneyEnabled} onClick={()=>run(async()=>{await api('exit',{entryId:p.id});await refresh();})}>Exit this real position</button></div>)}
      {status.realMoneyEnabled&&<button type="button" disabled={busy} onClick={()=>run(async()=>{await api('stop',{});await refresh();})}>Stop new real entries</button>}
    </div>}
    {plan&&<div><p>{plan.payload.symbol}</p><p>Buy limit {money(plan.buyPrice)} · {plan.lots} lots · {plan.payload.qty} quantity · Premium {money(plan.premiumCost)} before charges</p><p>Initial broker stop {money(plan.initialStop)}. Quotes and approval are checked again when submitted.</p>
      <button type="button" disabled={busy||!status?.realMoneyEnabled||Date.now()/1000>plan.expiresAt} onClick={()=>run(submit)}>Submit this real buy</button>
    </div>}
    {error&&<p role="alert">{error}</p>}
  </section>;
}
