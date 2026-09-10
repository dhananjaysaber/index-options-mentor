export default function MentorWorkflow({ snapshot }) {
  if (!snapshot) return null;

  const { setup = {}, decision = {}, market = {} } = snapshot;
  const state = market.phase === 'CLOSED' ? decision.reviewState : decision.state;

  const steps = [
    {
      id: 'opening',
      label: 'Open range',
      doneLabel: 'SET',
      status: setup.openingRangeReady ? 'done' : decision.state === 'OPENING_RANGE' ? 'active' : 'pending'
    },
    {
      id: 'bias',
      label: 'Bias',
      doneLabel: 'SET',
      status: setup.biasReady ? 'done' : ['BIAS_FORMING', 'NO_TRADE_DIRECTION'].includes(state) ? 'active' : 'pending'
    },
    {
      id: 'mandatory',
      label: '5 gates',
      doneLabel: 'PASSED',
      status: setup.mandatoryReady ? 'done' : state === 'NO_TRADE_MANDATORY' ? 'failed' : setup.biasReady ? 'active' : 'pending'
    },
    {
      id: 'breakout',
      label: 'Breakout',
      doneLabel: 'OBSERVED',
      status: setup.breakoutDetected ? 'done' : state === 'BIAS_FORMING' ? 'active' : 'pending'
    },
    {
      id: 'close',
      label: '5m close',
      doneLabel: 'CONFIRMED',
      status: setup.closeConfirmed ? 'done' : state === 'BREAKOUT_DETECTED' ? 'active' : 'pending'
    },
    {
      id: 'retest',
      label: 'Retest',
      doneLabel: 'HELD',
      status: setup.retestStatus === 'HELD' ? 'done' : setup.retestStatus === 'FAILED' ? 'failed' : setup.retestStatus === 'PENDING' ? 'active' : 'pending'
    },
    {
      id: 'approval',
      label: 'Approval',
      doneLabel: 'APPROVED',
      status: setup.approvalReady ? 'done' : ['RETEST_HELD_WATCH', 'RETEST_HELD_WAIT', 'NO_TRADE_RR'].includes(state) ? 'active' : 'pending'
    }
  ];

  return (
    <section className="mentor-workflow" aria-label="Live mentor workflow">
      <div className="workflow-label">
        <span>{market.phase === 'CLOSED' ? 'SESSION REVIEW' : 'LIVE PATH'}</span>
        <strong>{stageLabel(state)}</strong>
      </div>

      <div className="workflow-track">
        {steps.map((step, index) => (
          <div className={`workflow-step ${step.status}`} key={step.id}>
            <span className="workflow-number">{index + 1}</span>
            <strong>{step.label}</strong>
            <small>{statusLabel(step)}</small>
          </div>
        ))}
      </div>
    </section>
  );
}

function statusLabel(step) {
  if (step.status === 'done') return step.doneLabel || 'READY';
  if (step.status === 'failed') return 'FAILED';
  if (step.status === 'active') return 'NOW';
  return 'WAIT';
}

function stageLabel(state = '') {
  const labels = {
    PREMARKET: 'Pre-market',
    OPENING_RANGE: 'Opening range',
    DATA_PENDING: 'Live data pending',
    NO_TRADE_DIRECTION: 'Direction unclear',
    NO_TRADE_MANDATORY: 'Mandatory gate failed',
    BIAS_FORMING: 'Bias forming',
    BREAKOUT_DETECTED: 'Breakout detected',
    RETESTING: 'Retest pending',
    RETEST_FAILED: 'Retest failed',
    NO_TRADE_RR: 'Reward room failed',
    RETEST_HELD_WAIT: 'Retest held · waiting',
    RETEST_HELD_WATCH: 'Retest held · caution',
    QUALIFIED: 'Trade qualified',
    STRONG_SETUP: 'Strong setup'
  };
  return labels[state] || state.replaceAll('_', ' ');
}
