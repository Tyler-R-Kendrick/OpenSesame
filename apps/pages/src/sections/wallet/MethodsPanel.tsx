/**
 * Wallet › Payment methods — adapter capability truth (ADR 0123).
 * Metadata-only card UX; temporary cards stay UNAVAILABLE without an issuer.
 */

import { useEffect, useState } from "react";
import { IconCard } from "../../components/Icons.js";
import { TemporaryCardPanel } from "./TemporaryCardPanel.js";

type AdapterRow = {
  readonly id: string;
  readonly title: string;
  readonly evidenceStatus: string;
  readonly productionEnabled: boolean;
  readonly note: string;
};

async function loadAdapterRows(): Promise<readonly AdapterRow[]> {
  const [
    { createDirectErc20DelegationAdapter, InMemorySharedAncestorCounter },
    { describeX402Adapter },
  ] = await Promise.all([
    import("@opensesame/wallet-evm"),
    import("@opensesame/wallet-x402"),
  ]);

  const enforcer = new InMemorySharedAncestorCounter();
  const evm = createDirectErc20DelegationAdapter({
    mode: { kind: "simulation", enforcer },
  });
  const evmManifest = await evm.describe({
    origin: location.origin,
    nowIso: new Date().toISOString(),
  });
  const x402 = describeX402Adapter();

  return [
    {
      id: evmManifest.adapterId,
      title: "Restricted ERC-20 transfer (simulation)",
      evidenceStatus: evmManifest.evidenceStatus,
      productionEnabled: evmManifest.productionEnabled,
      note: "Browser path uses an in-memory counter. Period/amount shared-parent enforcement is proven under pnpm wallet:test:contracts (Anvil/forge); productionEnabled stays false.",
    },
    {
      id: x402.adapterId,
      title: "x402 exact payment",
      evidenceStatus: x402.evidenceStatus,
      productionEnabled: x402.productionEnabled,
      note: x402.blockedReason,
    },
  ];
}

export function MethodsPanel() {
  const [rows, setRows] = useState<readonly AdapterRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void loadAdapterRows()
      .then((next) => {
        if (!cancelled) setRows(next);
      })
      .catch((caught: Error) => {
        if (!cancelled) {
          setError(caught.message || "Could not load adapter manifests");
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <>
      <section className="panel">
        <div className="panel__head">
          <div>
            <h2>Payment methods</h2>
          </div>
        </div>
        <div className="panel__body">
          <div className="empty">
            <h3>No payment methods on file</h3>
            <p className="hint">
              Saved methods stay metadata-only until an evidence-gated adapter
              can settle. OpenSesame does not store PAN or CVV.
            </p>
          </div>
        </div>
      </section>

      <section className="panel" aria-labelledby="wallet-adapters">
        <div className="panel__head">
          <div>
            <h2 id="wallet-adapters">Execution adapters</h2>
            <p className="hint">
              Capability truth from package manifests — not marketing labels.
            </p>
          </div>
        </div>
        <div className="panel__body">
          {error ? <p className="hint">{error}</p> : null}
          {rows === null && error === null ? (
            <p className="hint">Loading adapter manifests…</p>
          ) : null}
          {rows !== null ? (
            <ul className="list">
              {rows.map((row) => (
                <li key={row.id} className="list__row">
                  <div>
                    <strong>{row.title}</strong>
                    <span className="chip">{row.evidenceStatus}</span>
                    {row.productionEnabled ? (
                      <span className="chip">production</span>
                    ) : (
                      <span className="chip">offline / local</span>
                    )}
                    <p className="hint">{row.note}</p>
                    <p className="hint">
                      <code>{row.id}</code>
                    </p>
                  </div>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      </section>

      <TemporaryCardPanel />
      <section className="panel">
        <div className="panel__head">
          <div>
            <h2>How cards work here</h2>
          </div>
        </div>
        <div className="panel__body">
          <p className="sent">
            <IconCard size={18} aria-hidden="true" /> Default card UX is
            checkout you mediate yourself. A temporary virtual card is only
            available when an issuer adapter reports ready — never as a pretend
            number.
          </p>
        </div>
      </section>
    </>
  );
}
