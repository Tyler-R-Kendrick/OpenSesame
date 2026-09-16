/**
 * Temporary / virtual card slot — unavailable until an evidence-gated issuer
 * adapter is present (ADR 0123 §3). Never invents a PAN.
 */

export function TemporaryCardPanel() {
  return (
    <section className="panel" aria-labelledby="wallet-temp-card-title">
      <div className="panel__head">
        <div>
          <h2 id="wallet-temp-card-title">Temporary card</h2>
        </div>
        <span className="chip chip--warn">UNAVAILABLE</span>
      </div>
      <div className="panel__body">
        <p className="hint">
          No card issuer is connected. A temporary card cannot be issued until
          an evidence-gated issuer adapter is present. No card number is shown
          because none exists.
        </p>
      </div>
    </section>
  );
}
