/**
 * Wallet › Payment methods — adapter capability truth (ADR 0123).
 * Metadata-only card UX; temporary cards stay UNAVAILABLE without an issuer.
 */

import { useEffect, useState } from "react";
import { IconCard } from "../../components/Icons.js";
import {
  type WalletEvidenceStatus,
  adapterProductionEnabled,
} from "../../lib/wallet-activation.js";
import { TemporaryCardPanel } from "./TemporaryCardPanel.js";

function productionEnabledFor(status: string, claimed: boolean): boolean {
  if (claimed !== true) return false;
  if (
    status !== "specified" &&
    status !== "source_inspected" &&
    status !== "fixture_verified" &&
    status !== "local_execution_verified" &&
    status !== "target_deployment_verified" &&
    status !== "blocked"
  ) {
    return false;
  }
  return adapterProductionEnabled({
    evidenceStatus: status as WalletEvidenceStatus,
    configFlag: true,
    uiToggle: true,
  });
}

type AdapterRow = {
  readonly id: string;
  readonly title: string;
  readonly evidenceStatus: string;
  readonly productionEnabled: boolean;
  readonly note: string;
};

async function loadAdapterRows(): Promise<readonly AdapterRow[]> {
  const [{ createDirectErc20DelegationAdapter }, { describeX402Adapter }] =
    await Promise.all([
      import("@opensesame/wallet-evm"),
      import("@opensesame/wallet-x402"),
    ]);

  const evm = createDirectErc20DelegationAdapter();
  const evmManifest = await evm.describe({
    origin: location.origin,
    nowIso: new Date().toISOString(),
  });
  const x402 = describeX402Adapter();

  return [
    {
      id: evmManifest.adapterId,
      title: "Restricted ERC-20 transfer",
      evidenceStatus: evmManifest.evidenceStatus,
      productionEnabled: productionEnabledFor(
        evmManifest.evidenceStatus,
        evmManifest.productionEnabled,
      ),
      note: "Pages does not send chain transactions. Shared-parent period and amount caps are proven by forge tests on local Anvil (pnpm wallet:test:contracts). Browser prepare/execute stays refused without that runtime. productionEnabled is false.",
    },
    {
      id: x402.adapterId,
      title: "x402 exact payment",
      evidenceStatus: x402.evidenceStatus,
      productionEnabled: productionEnabledFor(
        x402.evidenceStatus,
        x402.productionEnabled,
      ),
      note: x402.blockedReason,
    },
    {
      id: "ap2-ucp-vi",
      title: "AP2/UCP checkout evidence",
      evidenceStatus: "fixture_verified",
      productionEnabled: false,
      note: "ES256 fixtures verify against a local counterparty. Trust is fixture-local, not public merchant acceptance.",
    },
    {
      id: "prepaid-channel",
      title: "Prepaid session / escrow",
      evidenceStatus: "blocked",
      productionEnabled: false,
      note: "No pinned OSS prepaid-session harness in this checkout. Claims stay blocked, not mocked as complete.",
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
