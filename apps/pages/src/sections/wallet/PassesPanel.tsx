/**
 * Wallet › Spending passes — leases and reserved attempts.
 */

import { useCallback, useState } from "react";
import { IconTrash } from "../../components/Icons.js";
import { StatusNote } from "../../components/StatusNote.js";
import {
  listSpendingLeases,
  removeSpendingLease,
} from "../../lib/spending-leases.js";
import { formatUnits, getSpendingLedger } from "../../lib/spending-ledger.js";
import { safeMerchantLabel } from "../../lib/wallet-safe-label.js";

export function PassesPanel() {
  const [tick, setTick] = useState(0);
  const [message, setMessage] = useState<{
    tone: "ok" | "err" | "warn";
    text: string;
  } | null>(null);

  const refresh = useCallback(() => {
    setTick((n) => n + 1);
  }, []);
  void tick;

  const attempts = [...getSpendingLedger().snapshot().attempts.values()].filter(
    (attempt) => attempt.state === "reserved",
  );
  const leases = listSpendingLeases();

  return (
    <section className="panel" aria-labelledby="wallet-passes">
      <div className="panel__head">
        <div>
          <h2 id="wallet-passes">Spending passes</h2>
        </div>
      </div>
      <div className="panel__body">
        {leases.length === 0 && attempts.length === 0 ? (
          <div className="empty">
            <h3>No spending passes yet</h3>
          </div>
        ) : (
          <ul className="identity-rows">
            {leases.map((lease) => (
              <li key={lease.id} className="identity-row">
                <div className="identity-row__main">
                  <div className="identity-row__id">
                    <h3>
                      {lease.amount} {lease.currency} →{" "}
                      {safeMerchantLabel(lease.recipient)}
                    </h3>
                    <span className="identity-ref">{lease.status}</span>
                  </div>
                  <fieldset
                    className="vtree__keys actions"
                    aria-label="Lease actions"
                  >
                    <button
                      type="button"
                      className="icon-btn icon-btn--sm"
                      aria-label={`Remove lease ${lease.id}`}
                      title="Remove"
                      onClick={() => {
                        removeSpendingLease(lease.id);
                        refresh();
                      }}
                    >
                      <IconTrash size={15} />
                    </button>
                  </fieldset>
                </div>
              </li>
            ))}
            {attempts.map((attempt) => (
              <li key={attempt.attemptId} className="identity-row">
                <div className="identity-row__main">
                  <div className="identity-row__id">
                    <h3>
                      {formatUnits(attempt.amount)} on {attempt.nodeId}
                    </h3>
                    <span className="identity-ref">{attempt.state}</span>
                  </div>
                  <fieldset
                    className="vtree__keys actions"
                    aria-label="Reservation actions"
                  >
                    <button
                      type="button"
                      className="icon-btn icon-btn--sm"
                      aria-label={`Release ${attempt.attemptId}`}
                      title="Release"
                      onClick={() => {
                        try {
                          getSpendingLedger().release(attempt.attemptId);
                          refresh();
                        } catch (caught) {
                          setMessage({
                            tone: "err",
                            text:
                              caught instanceof Error
                                ? caught.message
                                : "Could not release",
                          });
                        }
                      }}
                    >
                      <IconTrash size={15} />
                    </button>
                  </fieldset>
                </div>
              </li>
            ))}
          </ul>
        )}
        {message ? <StatusNote message={message} /> : null}
      </div>
    </section>
  );
}
