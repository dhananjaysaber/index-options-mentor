import { useState } from 'react';
import { classifyResearchSetup, calculateSimulationSizing } from '../engine/researchStrategy.js';
import { calculateTradeAmountSizing } from '../engine/tradeAmount.js';
import { buildScalpTicket } from '../engine/scalpStrategy.js';
import TraderMarketPanel from './TraderMarketPanel.jsx';
import NiftyStrategyChart from './NiftyStrategyChart.jsx';
import MentorWorkflow from './MentorWorkflow.jsx';
import CoreQuickActions from './CoreQuickActions.jsx';
import PositionAlertBanner from './PositionAlertBanner.jsx';
import LivePositionPanel from './LivePositionPanel.jsx';
import History from './History.jsx';
import SettingsPanel from './SettingsPanel.jsx';

const fmt = value => value !== null && value !== undefined && value !== '' && Number.isFinite(Number(value))
  ? Number(value).toLocaleString('en-IN', { maximumFractionDigits: 2 }) : '—';
const money = value => '₹' + fmt(value);
const positive = value => Number.isFinite(Number(value)) && Number(value) > 0 ? Number(value) : null;
const count = (rows, test) => rows.filter(test).length;
const pretty = value => String(value || '').replaceAll('_', ' ').toUpperCase();
const suffix = value => value == null ? '—' : String(value);

function Value({ label, value, tone = '' }) {
  return <div className={'fyers-ref-value ' + tone}><span>{label}</span><strong>{value}</strong></div>;
}
function SectionHead({ title, aside }) {
  return <div className="fyers-ref-section-head"><span>{title}</span><strong>{aside}</strong></div>;
}
function RefSwitch({ label, checked, onChange }) {
  return <label className="fyers-ref-switch"><input type="checkbox" checked={Boolean(checked)} onChange={event => onChange(event.target.checked)} /><span aria-hidden="true" />{label}</label>;
}
function ParamLabel({ row }) {
  return <span title={row?.label || row?.id || ''}>{row?.label || pretty(row?.id)}</span>;
}
function ParamTone(row) {
  if (row?.mandatory) return row.gatePassed ? 'pass' : 'fail';
  return row?.status === 'green' ? 'pass' : row?.status === 'amber' ? 'partial' : 'fail';
}
function Dots({ rows, compact = false }) {
  return <div className={compact ? 'fyers-ref-dots confirmations' : 'fyers-ref-dots mandatory'}>
    {rows.map(row => <div className={'fyers-ref-dot ' + ParamTone(row)} key={row.id || row.label}>
      {compact && <i aria-hidden="true" />}
      <ParamLabel row={row} />
      <strong>{row?.mandatory ? (row.gatePassed ? 'PASS' : 'WAIT') : (row.status === 'green' ? 'PASS' : row.status === 'amber' ? 'PART' : 'WAIT')}</strong>
    </div>)}
  </div>;
}
export function FyersMarketContext({ snapshot }) {
  const market = snapshot?.market || {};
  const values = [['VIX',market.vix],['OI PCR',market.putCallOiRatio],['5m ATR',market.atr5],['Retest',snapshot?.setup?.retestStatus || '—']];
  const levels = [['PDH',market.pdh],['PDL',market.pdl],['ORH',market.orh],['ORL',market.orl],['VWAP',market.vwap]];
  return <section className="fyers-ref-card fyers-ref-context">
    <SectionHead title="LIVE MARKET CONTEXT" aside="WHAT THE MENTOR IS READING" />
    <div className="fyers-ref-context-grid top">{values.map(([label,value])=><Value key={label} label={label} value={typeof value === 'number' ? fmt(value) : suffix(value)} tone={label === 'Retest' && value === 'HELD' ? 'positive' : ''}/>)}</div>
    <div className="fyers-ref-context-grid bottom">{levels.map(([label,value])=><Value key={label} label={label} value={fmt(value)}/>)}</div>
  </section>;
}
function FyersCoreDecision({ snapshot, liveQuote, settings, onDetail, onTicket, marketDataReady, mode }) {
  const s = snapshot || {};
  const classification = classifyResearchSetup(snapshot);
  const mandatory = (s.parameters || []).filter(row => row.mandatory);
  const confirms = (s.parameters || []).filter(row => !row.mandatory);
  const option = s.option || {};
  const decision = s.decision || {};
  const sizing = calculateSimulationSizing(snapshot, settings, liveQuote);
  const quotePrice = liveQuote && liveQuote.optionSymbol === option.symbol ? positive(liveQuote.optionPrice) : null;
  const entry = quotePrice ?? positive(option.ltp);
  const qualified = Boolean(classification.eligible && marketDataReady);
  const direction = option.optionType || decision.side || '—';
  const action = direction === 'PE' ? 'BUY PE' : direction === 'CE' ? 'BUY CE' : 'WATCH';
  return <section className="fyers-ref-card fyers-ref-decision" aria-label="13-point decision">
    <div className="fyers-ref-decision-top">
      <div><div className="fyers-ref-verdict"><strong>{action}</strong><span className={qualified ? 'fyers-ref-tag good' : 'fyers-ref-tag wait'}>{qualified ? 'QUALIFIED' : 'WAITING'}</span><span className="fyers-ref-tag blue">{classification.tier || 'RESEARCH'}</span></div>
        <div className="fyers-ref-contract">{option.symbol || 'Waiting for FYERS option'} · Lots {sizing?.lots || '—'} · Qty {sizing?.quantity || '—'}</div>
      </div>
      <button className="fyers-ref-score" type="button" onClick={onDetail} aria-label="Open 13-point Advanced detail"><b>{Number.isFinite(Number(decision.score)) && decision.score != null ? decision.score : '—'}</b><small>/100</small><span>Advanced ›</span></button>
    </div>
    {mode === 'advanced' && <><SectionHead title="MANDATORY · HARD SAFETY" aside={String(classification.mandatoryPassCount ?? 0) + '/5'} />
    <Dots rows={mandatory}/>
    <SectionHead title="CONFIRMATIONS" aside={String(classification.confirmationPassCount ?? 0) + '/8'} />
    <Dots rows={confirms} compact /></>}
    <div className="fyers-ref-price-grid">
      <Value label="Entry" value={money(entry)} />
      <Value label="Stop" value={money(option.estimatedPremiumStop)} tone="danger" />
      <Value label="Target" value={money(option.estimatedPremiumTarget)} tone="positive" />
      <Value label="R:R" value={Number.isFinite(Number(decision.rr)) && decision.rr != null ? Number(decision.rr).toFixed(1) : '—'} />
    </div>
    <div className="fyers-ref-invalidation">NIFTY invalidation {fmt(s.structure?.underlyingStop)} · Target {fmt(s.structure?.underlyingTarget)} · Premium cost {money(sizing?.premiumCost)}</div>
    <p className="fyers-ref-mentor"><b>MENTOR SAYS · </b>{decision.reasons?.join(' · ') || classification.reason || 'Waiting for confirmed market research.'}</p>
    <div className="fyers-ref-review-link"><button type="button" onClick={onTicket} disabled={!option?.symbol}>Review trade ticket · text only</button></div>
  </section>;
}
function Pnl({ position, quote }) {
  if (!position) return <span className="fyers-ref-muted">No position · watching</span>;
  const last = quote?.optionSymbol === position.symbol ? positive(quote.optionPrice) : positive(position.currentPrice);
  const entry = positive(position.entry);
  const pnl = last != null && entry != null ? (last - entry) * Number(position.quantity || 0) : null;
  return <strong className={pnl == null ? '' : pnl >= 0 ? 'positive' : 'danger'}>{pnl == null ? '—' : (pnl >= 0 ? '+' : '−') + money(Math.abs(pnl))}</strong>;
}
function FyersPositionStrip({ corePosition, scalpPosition, liveQuote, onOpen, onExit }) {
  const core = corePosition, scalp = scalpPosition;
  const rows = [['13-POINT',core,'core'],['SCALP',scalp,'scalp']];
  return <section className="fyers-ref-card fyers-ref-position-strip">
    <div className="fyers-ref-position-head"><button type="button" onClick={onOpen}>Open positions · {Number(Boolean(core)) + Number(Boolean(scalp))}</button><span>Core and Scalp · independent slots</span></div>
    <div className="fyers-ref-position-columns"><span>Instrument</span><span>Strategy</span><span>Qty</span><span>Entry</span><span>LTP</span><span>P&L</span><span></span></div>
    {rows.map(([name,position,strategy])=><div className="fyers-ref-position-row" key={strategy}>
      <strong>{position?.symbol || name + ' slot'}</strong><span>{position ? name + ' · ' + (position.initiatedBy || 'PAPER') : 'No position · watching'}</span>
      <span>{position?.quantity ?? '—'}</span><span>{position ? money(position.entry) : '—'}</span>
      <span>{position ? money(liveQuote?.optionSymbol === position.symbol ? liveQuote.optionPrice : position.currentPrice) : '—'}</span><Pnl position={position} quote={liveQuote}/>
      <button type="button" disabled={!position} onClick={() => onExit(strategy, { closedBy:'USER', reasonCode:'MANUAL_EXIT', reason:'Manual simulated exit from positions table.' })}>SELL</button>
    </div>)}
  </section>;
}
export function FyersCoreTrade({ snapshot, liveQuote, settings, setSettings, mode, marketDataReady, corePosition, scalpPosition, coreMentor, history, onTakeTrade, onExit, onNavigate, alertsEnabled }) {
  return <div className="fyers-ref-page fyers-ref-core">
    <div className="fyers-ref-trade-grid">
      <div className="fyers-ref-chart-column">
        <div className="fyers-ref-chart"><TraderMarketPanel snapshot={snapshot}/></div>
        <div className="fyers-ref-livepath"><MentorWorkflow snapshot={snapshot}/></div>
        <div className="fyers-ref-desktop-positions"><FyersPositionStrip corePosition={corePosition} scalpPosition={scalpPosition} liveQuote={liveQuote} onOpen={()=>onNavigate('position')} onExit={onExit}/></div>
      </div>
      <div className="fyers-ref-decision-column">
        {corePosition && <PositionAlertBanner position={corePosition} mentor={coreMentor} alertsEnabled={alertsEnabled} onExit={meta=>onExit('core',{...meta,closedBy:'USER'})}/>}
        <FyersCoreDecision snapshot={snapshot} liveQuote={liveQuote} settings={settings} marketDataReady={marketDataReady} mode={mode} onDetail={()=>onNavigate('detail')} onTicket={()=>onNavigate('ticket')}/>
        <FyersMarketContext snapshot={snapshot}/>
        {corePosition && <LivePositionPanel position={corePosition} onExit={meta=>onExit('core',meta)} history={history} snapshot={snapshot}/>}
        <div className="fyers-ref-actions">
          <RefSwitch label="Auto entry + manage" checked={settings.mentorAutoOpen && settings.mentorAutoClose} onChange={checked=>setSettings(value=>({...value,mentorAutoOpen:checked,mentorAutoClose:checked}))}/>
          <CoreQuickActions snapshot={snapshot} liveQuote={liveQuote} marketDataReady={marketDataReady} settings={settings} position={corePosition} onTakeTrade={onTakeTrade} onExit={meta=>onExit('core',meta)}/>
        </div>
      </div>
    </div>
  </div>;
}
export function FyersScalpTrade({ snapshot, evaluation, position, corePosition, positionMentor, marketDataReady, settings, setSettings, liveQuote, history, alertsEnabled, onTakeTrade, onExit, onNavigate }) {
  const ev = evaluation || {};
  const checks = Array.isArray(ev.checks) ? ev.checks : [];
  const option = snapshot?.option || {};
  const price = liveQuote && liveQuote.optionSymbol === option.symbol ? positive(liveQuote.optionPrice) : positive(option.ltp);
  const sizing = calculateTradeAmountSizing(settings, price, Number(option.lotSize));
  const ready = Boolean(marketDataReady && ev.manualEligible && sizing.lots > 0 && !position);
  function manual(side) {
    if (!ready || ev.side !== side || !snapshot) return;
    const ticket = buildScalpTicket(snapshot, ev, settings, 'USER', { lots:sizing.lots });
    if (ticket) onTakeTrade(ticket);
  }
  return <div className="fyers-ref-page fyers-ref-scalp">
    <div className="fyers-ref-scalp-grid">
      <div className="fyers-ref-chart-column">
        <section className="fyers-ref-card fyers-ref-scalp-chart"><NiftyStrategyChart snapshot={snapshot} position={position} defaultTimeframe="3" strategyNote="5m context · 3m execution" /></section>
        <div className="fyers-ref-desktop-positions"><FyersPositionStrip corePosition={corePosition} scalpPosition={position} liveQuote={liveQuote} onOpen={()=>onNavigate('position')} onExit={onExit}/></div>
      </div>
      <div className="fyers-ref-decision-column">
        {position && <><PositionAlertBanner position={position} mentor={positionMentor} alertsEnabled={alertsEnabled} onExit={meta=>onExit('scalp',{...meta,closedBy:'USER'})}/><LivePositionPanel position={position} onExit={meta=>onExit('scalp',meta)} history={history} snapshot={snapshot}/></>}
        <section className="fyers-ref-card fyers-ref-scalp-decision">
          <div className="fyers-ref-decision-top"><div><div className="fyers-ref-verdict"><strong>BUY {ev.side || '—'}</strong><span className={ev.eligible && marketDataReady ? 'fyers-ref-tag good' : 'fyers-ref-tag wait'}>{ev.eligible && marketDataReady ? 'SCALP READY' : 'WAITING'}</span></div><div className="fyers-ref-contract">{option.symbol || 'Waiting for candidate'} · strict scalp rules</div></div><div className="fyers-ref-score"><b>{Number.isFinite(ev.score) ? ev.score : '—'}</b><small>/100</small></div></div>
          <SectionHead title="FAST-ENTRY CHECKLIST · STRICT SCALP RULES" aside={count(checks,row=>row.pass) + '/' + checks.length}/>
          <div className="fyers-ref-dots scalp">{checks.map(c=><div key={c.id} title={c.detail} className={'fyers-ref-dot ' + (c.pass ? 'pass' : 'fail')}><span>{c.label}</span><strong>{c.pass?'PASS':'WAIT'}</strong></div>)}</div>
          {corePosition && <div className="fyers-ref-notice">13-point position still active · independent Core slot</div>}
          <div className="fyers-ref-price-grid"><Value label="Entry" value={money(price)}/><Value label="Stop" value={money(option.estimatedPremiumStop)} tone="danger"/><Value label="Target 1R" value={money(option.estimatedPremiumTarget)} tone="positive"/><Value label="Max hold" value="12 min"/></div>
          <div className="fyers-ref-invalidation">Lots {sizing.lots || '—'} · Qty {sizing.quantity || '—'} · Cost {money(sizing.premiumCost)} · NIFTY trigger {fmt(ev.trigger)}</div>
          <p className="fyers-ref-mentor"><b>MENTOR SAYS · </b>{ev.reason || 'Waiting for confirmed three-minute scalp structure.'}</p>
        </section>
        <div className="fyers-ref-actions">
          <div className="fyers-ref-toggle-row"><RefSwitch label="Auto entry" checked={settings.scalpAutoOpen} onChange={checked=>setSettings(value=>({...value,scalpAutoOpen:checked}))}/><RefSwitch label="Auto close" checked={settings.scalpAutoClose} onChange={checked=>setSettings(value=>({...value,scalpAutoClose:checked}))}/></div>
          <div className="fyers-ref-scalp-buy"><button type="button" className="ce" disabled={!ready || ev.side!=='CE'} onClick={()=>manual('CE')}>Buy CE</button><button type="button" className="pe" disabled={!ready || ev.side!=='PE'} onClick={()=>manual('PE')}>Buy PE</button></div>
          <button className="fyers-ref-scalp-sell" type="button" disabled={!position} onClick={()=>onExit('scalp',{closedBy:'USER',reasonCode:'MANUAL_EXIT',reason:'Manual scalp exit'})}>SELL · Exit scalp</button>
        </div>
      </div>
    </div>
  </div>;
}
export function FyersDetail({ snapshot, onBack }) {
  const rows = Array.isArray(snapshot?.parameters) ? snapshot.parameters : [];
  const mandatory = rows.filter(r=>r.mandatory), confirm = rows.filter(r=>!r.mandatory);
  const classification = classifyResearchSetup(snapshot);
  return <div className="fyers-ref-page fyers-ref-detail">
    <button type="button" className="fyers-ref-back" onClick={onBack}>‹ Back</button>
    <h1>13-point detail</h1><p>Advanced view · score {snapshot?.decision?.score ?? '—'}/100</p>
    <section className="fyers-ref-card"><SectionHead title="MANDATORY" aside={classification.mandatoryPassCount + '/5 · ' + (classification.hardSafetyPassed?'SAFETY PASS':'WAIT')}/>{mandatory.map(row=><div className={'fyers-ref-param-row ' + ParamTone(row)} key={row.id}><ParamLabel row={row}/><div className="fyers-ref-progress"><span style={{width:row.gatePassed?'100%':'12%'}}/></div><strong>{row.gatePassed?'PASS':'WAIT'}</strong></div>)}</section>
    <section className="fyers-ref-card"><SectionHead title="CONFIRMATIONS" aside={classification.confirmationPassCount+'/8'}/>{confirm.map(row=><div className={'fyers-ref-param-row ' + ParamTone(row)} key={row.id}><ParamLabel row={row}/><div className="fyers-ref-progress"><span style={{width:row.status==='green'?'100%':row.status==='amber'?'50%':'7%'}}/></div><strong>{row.status==='green'?'PASS':row.status==='amber'?'PART':'WAIT'}</strong></div>)}</section>
    <FyersMarketContext snapshot={snapshot}/>
  </div>;
}
export function FyersTicket({ snapshot, settings, liveQuote, onBack }) {
  const [copied,setCopied] = useState(false);
  const option = snapshot?.option || {}, market = snapshot?.market || {}, structure=snapshot?.structure || {};
  const sizing = calculateSimulationSizing(snapshot,settings,liveQuote);
  const price = liveQuote && liveQuote.optionSymbol === option.symbol ? positive(liveQuote.optionPrice) : positive(option.ltp);
  const values = [['Lots / Qty',(sizing.lots||'—') + ' / ' + (sizing.quantity||'—')],['Option ref.',money(option.ltp)],['Buy option price · limit',money(price)],['Initial stop price',money(option.estimatedPremiumStop)],['NIFTY stop',fmt(structure.underlyingStop)],['NIFTY target',fmt(structure.underlyingTarget)],['Premium cost',money(sizing.premiumCost)],['Amount per trade',money(settings.tradeAmount)]];
  function copy() {
    const text = ['TRADE PLAN · TEXT ONLY', 'Symbol: '+(option.symbol||'—'), 'Spot: '+fmt(market.spot), ...values.map(([label,value])=>label+': '+value)].join('\n');
    if (navigator.clipboard?.writeText) void navigator.clipboard.writeText(text).then(()=>setCopied(true)).catch(()=>setCopied(false));
  }
  return <div className="fyers-ref-page fyers-ref-ticket"><button type="button" className="fyers-ref-back" onClick={onBack}>‹ Back</button><h1>Review 13-point trade</h1><p>Text only · no order sent</p>
    <section className="fyers-ref-card"><SectionHead title={'BUY · '+(option.symbol||'WAITING FOR OPTION')} aside="13-POINT · RESEARCH"/>{values.map(([label,value])=><div className="fyers-ref-ticket-row" key={label}><span>{label}</span><strong>{value}</strong></div>)}</section>
    <p className="fyers-ref-disclaimer">TRADE PLAN · NOT PURCHASED. Brokerage and other charges are extra. The review screen does not submit any broker order.</p>
    <button className="fyers-ref-copy" onClick={copy} disabled={!option.symbol}>{copied?'Trade details copied':'Copy trade details'}</button>
    <div className="fyers-ref-disabled">Submit real buy · unavailable on this review screen</div>
  </div>;
}
export function FyersPositions({ defaultSlot = 'core', corePosition, scalpPosition, history, snapshot, coreMentor, scalpMentor, alertsEnabled, onExit }) {
  const [slot,setSlot] = useState(defaultSlot);
  const completed = Array.isArray(history) ? history.filter(x=>x?.closedAt) : [];
  const today = completed.filter(x=>new Date(x.closedAt).toDateString()===new Date().toDateString());
  const total = today.reduce((sum,x)=>sum+Number(x.pnl||0),0);
  return <div className="fyers-ref-page fyers-ref-positions"><h1>Positions</h1><p>Open paper positions · both strategies independent</p>
    <div className="fyers-ref-segment"><button type="button" className={slot==='core'?'active':''} onClick={()=>setSlot('core')}>13-Point · {corePosition?1:0}</button><button type="button" className={slot==='scalp'?'active':''} onClick={()=>setSlot('scalp')}>Scalp · {scalpPosition?1:0}</button></div>
    <div className="fyers-ref-position-active">
      {slot==='core'?<><PositionAlertBanner position={corePosition} mentor={coreMentor} alertsEnabled={alertsEnabled} onExit={meta=>onExit('core',{...meta,closedBy:'USER'})}/><LivePositionPanel position={corePosition} onExit={meta=>onExit('core',meta)} history={history} snapshot={snapshot}/></>:<><PositionAlertBanner position={scalpPosition} mentor={scalpMentor} alertsEnabled={alertsEnabled} onExit={meta=>onExit('scalp',{...meta,closedBy:'USER'})}/><LivePositionPanel position={scalpPosition} onExit={meta=>onExit('scalp',meta)} history={history} snapshot={snapshot}/></>}
    </div>
    <div className="fyers-ref-today"><Value label="Trades today" value={today.length}/><Value label="Wins" value={count(today,t=>Number(t.pnl)>0)} tone="positive"/><Value label="Losses" value={count(today,t=>Number(t.pnl)<0)} tone="danger"/><Value label="Net" value={money(total)} tone={total>=0?'positive':'danger'}/></div>
    <div className="fyers-ref-positions-secondary">{slot==='core'?'Scalp':'13-Point'} slot · {(slot==='core'?scalpPosition:corePosition)?'1 open position':'No position · watching'}</div>
  </div>;
}
export function FyersJournal({ history, onNavigate }) {
  const [source,setSource]=useState('all');
  const [strategy,setStrategy]=useState('all');
  const rows=Array.isArray(history)?Array.from(new Map(history.filter(x=>x?.id).map(x=>[x.id,x])).values()):[];
  const filtered=rows.filter(row=>{
    const scalp = row.strategyFamily==='SCALP'||row.strategyTier==='SCALP';
    const src = row.entryMethod || (row.initiatedBy==='MENTOR'?'AUTO':row.initiatedBy==='USER'?'MANUAL':'');
    const shadow = /SHADOW/i.test(String(row.source||'')+' '+String(row.strategyTier||'')+' '+String(row.initiatedBy||''));
    return (strategy==='all'||(strategy==='scalp'?scalp:!scalp)) && (source==='all'||(source==='shadow'?shadow:source===src.toLowerCase()&&!shadow));
  });
  return <div className="fyers-ref-page fyers-ref-journal"><div className="fyers-ref-journal-title"><h1>Trade journal</h1><p>Permanent learning loop</p></div>
    <div className="fyers-ref-segment"><button className="active" type="button">Journal</button><button type="button" onClick={()=>onNavigate('analysis')}>Analysis</button></div>
    <div className="fyers-ref-journal-filters"><div>{[['all','All'],['core','13-point'],['scalp','Scalp']].map(([v,label])=><button type="button" className={strategy===v?'active':''} onClick={()=>setStrategy(v)} key={v}>{label}</button>)}</div><div>{[['all','Any source'],['auto','Auto'],['shadow','Shadow'],['manual','Manual']].map(([v,label])=><button type="button" className={source===v?'active':''} onClick={()=>setSource(v)} key={v}>{label}</button>)}</div></div>
    <History history={filtered}/>
  </div>;
}
export function FyersSettings({ settings, onSave }) {
  return <div className="fyers-ref-page fyers-ref-settings"><h1>Settings</h1><p>Account, automation and risk</p><SettingsPanel settings={settings} onSave={onSave}/></div>;
}
