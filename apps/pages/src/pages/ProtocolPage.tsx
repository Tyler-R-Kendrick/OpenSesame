export function ProtocolPage() {
  return (
    <section className="panel">
      <h1>Trust Ratchet & profiles</h1>
      <p>
        OpenSesame keeps protocol adapters around a canonical core: Identity →
        AuthorityContext → TaskTemplate → immutable ceiling → monotonic current
        capabilities → FrozenIntent → mediation → proof-bound credential →
        enforcement evidence.
      </p>
      <ul className="status-list">
        <li>
          <span className="k">Ceiling</span>
          <span className="v">Immutable after task activation</span>
        </li>
        <li>
          <span className="k">Ratchet</span>
          <span className="v">next ⊆ current ⊆ ceiling — never widen</span>
        </li>
        <li>
          <span className="k">MCP 2026-07-28</span>
          <span className="v">Authorization: Bearer — not DPoP</span>
        </li>
        <li>
          <span className="k">OpenSesame DPoP</span>
          <span className="v">Authorization: DPoP + DPoP proof JWT</span>
        </li>
        <li>
          <span className="k">AAuth</span>
          <span className="v">Experimental adapter — disabled by default</span>
        </li>
      </ul>
      <p className="hint">
        DPoP does not bind query strings, bodies, or MCP tool arguments —
        FrozenIntent does. Knowledge of a ConnectionRef is not capability.
      </p>
    </section>
  );
}
