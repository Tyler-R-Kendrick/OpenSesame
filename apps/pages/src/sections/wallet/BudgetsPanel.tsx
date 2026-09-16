/**
 * Wallet › Budgets — conserved local ledger (ADR 0123).
 *
 * Creates a shared-counter household demo and shows exact subunit amounts.
 * Sibling overspend is refused by the journal, not by UI copy.
 */

import { useCallback, useState } from "react";
import { StatusNote } from "../../components/StatusNote.js";
import { buildLocalPaymentApprovalDigest } from "../../lib/spending-consent.js";
import {
  clearSpendingLedgerStorage,
  formatUnits,
  getSpendingLedger,
  listBudgetRows,
  openDemoHouseholdBudget,
  resetSpendingLedgerCache,
  trySiblingOverspendDemo,
} from "../../lib/spending-ledger.js";

export function BudgetsPanel() {
  const [tick, setTick] = useState(0);
  const [message, setMessage] = useState<{
    tone: "ok" | "err" | "warn";
    text: string;
  } | null>(null);
  const [approvalDigest, setApprovalDigest] = useState<string | null>(null);

  const refresh = useCallback(() => {
    setTick((n) => n + 1);
  }, []);

  // tick forces re-read after mutations
  void tick;
  const rows = listBudgetRows(getSpendingLedger());

  const onCreateDemo = () => {
    setMessage(null);
    setApprovalDigest(null);
    try {
      openDemoHouseholdBudget();
      void buildLocalPaymentApprovalDigest({
        currency: "TEST",
        amount: "1000",
        recipient: "household",
      }).then((digest) => {
        setApprovalDigest(digest);
      });
      setMessage({
        tone: "ok",
        text: "Opened a 1000-subunit shared household budget with two children.",
      });
      refresh();
    } catch (caught) {
      setMessage({
        tone: "err",
        text:
          caught instanceof Error ? caught.message : "Could not open budget",
      });
    }
  };

  const onSiblingDemo = () => {
    setMessage(null);
    setApprovalDigest(null);
    try {
      const result = trySiblingOverspendDemo();
      if (result.firstOk && !result.secondOk) {
        void buildLocalPaymentApprovalDigest({
          currency: "TEST",
          amount: "700",
          recipient: "child-a",
        }).then((digest) => {
          setApprovalDigest(digest);
        });
        setMessage({
          tone: "ok",
          text: "First sibling reserved 700; second 400 refused — shared remainder conserved.",
        });
      } else if (result.firstOk && result.secondOk) {
        setMessage({
          tone: "warn",
          text: "Both reservations succeeded — check remaining capacity before claiming an overspend test.",
        });
      } else {
        setMessage({
          tone: "err",
          text: "Demo reservation failed unexpectedly.",
        });
      }
      refresh();
    } catch (caught) {
      setMessage({
        tone: "err",
        text: caught instanceof Error ? caught.message : "Demo failed",
      });
    }
  };

  const onReset = () => {
    clearSpendingLedgerStorage();
    resetSpendingLedgerCache();
    setApprovalDigest(null);
    setMessage({
      tone: "warn",
      text: "Cleared this browser's local budget ledger. External authority is unaffected.",
    });
    refresh();
  };

  return (
    <section className="panel" aria-labelledby="wallet-budgets">
      <div className="panel__head">
        <div>
          <h2 id="wallet-budgets">Budgets</h2>
          <p className="hint">
            Exact integer subunits on this device. A local ledger is not a
            hostile-owner money counter and does not settle offline.
          </p>
        </div>
      </div>
      <div className="panel__body">
        <div className="row gap">
          <button type="button" className="btn" onClick={onCreateDemo}>
            Open demo household budget
          </button>
          <button type="button" className="btn" onClick={onSiblingDemo}>
            Try sibling overspend
          </button>
          <button type="button" className="btn" onClick={onReset}>
            Clear local ledger
          </button>
        </div>

        {rows.length === 0 ? (
          <div className="empty">
            <h3>No budgets yet</h3>
            <p className="hint">
              Open the demo household budget to exercise shared-counter
              conservation, or wait for an owner-approved policy allocation.
            </p>
          </div>
        ) : (
          <ul className="list">
            {rows.map((row) => (
              <li key={row.nodeId} className="list__row">
                <div>
                  <strong>{row.label}</strong>
                  <span className="hint">
                    {" "}
                    · {row.strategy.replace("_", " ")}
                  </span>
                  <p className="hint">
                    ceiling {formatUnits(row.ceiling)} · available{" "}
                    {formatUnits(row.locallyAvailable)} · reserved to children{" "}
                    {formatUnits(row.reservedToChildren)} · exposure{" "}
                    {formatUnits(row.unresolvedExternalExposure)} · posted{" "}
                    {formatUnits(row.postedSpending)}
                  </p>
                </div>
              </li>
            ))}
          </ul>
        )}

        {approvalDigest ? (
          <p className="hint" data-testid="wallet-approval-digest">
            Local approval digest (executable terms only; not WebAuthn proof):{" "}
            <code>{approvalDigest}</code>
          </p>
        ) : null}

        {message ? <StatusNote message={message} /> : null}
      </div>
    </section>
  );
}
