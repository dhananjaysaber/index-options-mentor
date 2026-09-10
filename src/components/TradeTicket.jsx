export default function TradeTicket({ ticket, onTakeTrade, disabledReason }) {
  return (
    <section className="panel trade-ticket">
      <div className="panel-heading">
        <div>
          <div className="eyebrow">EXECUTION PLAN</div>
          <h2>Suggested simulated trade</h2>
        </div>
        <span className="demo-pill">SIMULATION ONLY</span>
      </div>

      {!ticket ? (
        <div className="empty-state">
          <strong>No ticket yet.</strong>
          <p>The trade ticket appears only after all mandatory gates pass and the confluence score qualifies.</p>
        </div>
      ) : (
        <>
          <div className="ticket-grid">
            <div><span>Direction</span><strong>Buy {ticket.side}</strong></div>
            <div><span>Strike</span><strong>{ticket.strike}</strong></div>
            <div><span>Entry</span><strong>₹{ticket.entry.toFixed(2)}</strong></div>
            <div><span>Stop</span><strong>₹{ticket.stop.toFixed(2)}</strong></div>
            <div><span>Target</span><strong>₹{ticket.target.toFixed(2)}</strong></div>
            <div><span>R:R</span><strong>1 : {ticket.rr.toFixed(1)}</strong></div>
            <div><span>Lot size</span><strong>{ticket.lotSize}</strong></div>
            <div><span>Allowed lots</span><strong>{ticket.lots}</strong></div>
          </div>

          {ticket.lots === 0 ? (
            <div className="risk-blocker">
              Risk blocker: even one lot exceeds the current per-trade risk budget of ₹{ticket.maxRiskRupees.toLocaleString('en-IN')}.
            </div>
          ) : (
            <button className="primary-btn" onClick={() => onTakeTrade(ticket)}>
              Take simulated trade
            </button>
          )}

          {disabledReason && <p className="muted">{disabledReason}</p>}
        </>
      )}
    </section>
  );
}
