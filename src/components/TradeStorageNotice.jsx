import { useEffect, useState } from 'react';
import { exportTradingRecovery, tradingStorageStatus } from '../services/tradingStorage.js';
export default function TradeStorageNotice(){
  const [status,setStatus]=useState(tradingStorageStatus);
  useEffect(()=>{const update=()=>setStatus(tradingStorageStatus());window.addEventListener('mentor:storage-status',update);return()=>window.removeEventListener('mentor:storage-status',update);},[]);
  if(!status.cacheBlocked)return null;
  return <div className="alert-bar" role="status">{status.durableAvailable?'The phone’s small cache is full. Trade recovery storage is available; SELL can still save there.':'Device saving is limited. Keep this app open until the journal confirms your exit.'} Do not clear app data. Recovery export is in Trade journal.</div>;
}
export function TradeRecoveryPanel(){
  const [busy,setBusy]=useState(false),[message,setMessage]=useState('');
  async function download(){
    if(busy)return;setBusy(true);setMessage('');
    try{
      const data=await exportTradingRecovery();
      const blob=new Blob([JSON.stringify(data,null,2)],{type:'application/json'}),url=URL.createObjectURL(blob);
      const a=document.createElement('a');a.href=url;a.download='mentor-trade-recovery-'+new Date().toISOString().slice(0,10)+'.json';a.click();
      window.setTimeout(()=>URL.revokeObjectURL(url),1000);
      setMessage('Recovery export created. It includes saved trades and pending trade events, without your FYERS login. Unrecorded exits are not assigned invented profits.');
    }catch{setMessage('Recovery export could not finish. Keep the app data and try again.');}finally{setBusy(false);}
  }
  return <details className="panel"><summary>Trade recovery</summary><p>Export this device’s saved positions, journal and pending events. This does not place, close or change a trade.</p><button type="button" disabled={busy} onClick={download}>{busy?'Preparing recovery export…':'Export saved recovery data'}</button>{message&&<p role="status">{message}</p>}</details>;
}
