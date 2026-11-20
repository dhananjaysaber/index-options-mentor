import React from 'react';

// If a trading screen throws during rendering, show a recoverable error
// instead of leaving an unresponsive black PWA. Does not alter trade state.
export default class AppErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { failed: false };
  }

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(error, info) {
    console.error('Index Options Mentor screen error', error, info?.componentStack);
  }

  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <main role="alert" style={{
        minHeight: '100dvh', background: '#091626', color: '#eaf1fc',
        padding: 'max(100px, env(safe-area-inset-top, 48px)) 22px 40px',
        fontFamily: 'system-ui, sans-serif'
      }}>
        <h1 style={{ fontSize: 24, marginBottom: 12 }}>Mentor screen could not load</h1>
        <p style={{ lineHeight: 1.6, maxWidth: 500 }}>
          A screen error occurred. Your saved simulated positions and trade journal
          have not been deliberately cleared. Check the journal after reloading
          before attempting another SELL.
        </p>
        <button type="button" onClick={() => window.location.reload()} style={{
          color: '#092137', background: '#53c8ff', border: 'none',
          padding: '14px 18px', borderRadius: 10, fontWeight: 700
        }}>Reload Mentor</button>
      </main>
    );
  }
}
