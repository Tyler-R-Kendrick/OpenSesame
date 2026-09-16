/**
 * Wallet › Activity — journal observations from the local budget ledger.
 * Never invents settlement; shows reserved/committed/released only.
 */

import type { JournalEntry } from "@opensesame/wallet-budget";
import { useCallback, useState } from "react";
import {
  formatUnits,
  getSpendingLedger,
  listBudgetRows,
} from "../../lib/spending-ledger.js";

function describeEntry(entry: JournalEntry): string {
  switch (entry.kind) {
    case "node_opened":
      return `Opened ${entry.nodeId} (ceiling ${formatUnits(entry.ceiling)}, ${entry.strategy.replaceAll("_", " ")})`;
    case "exclusive_allocated":
      return `Exclusive ${formatUnits(entry.amount)} → ${entry.childId} from ${entry.parentId}`;
    case "reserved":
      return `Reserved ${formatUnits(entry.amount)} on ${entry.nodeId} (${entry.attemptId})`;
    case "committed":
      return `Committed ${entry.attemptId}`;
    case "released":
      return `Released ${entry.attemptId}`;
  }
}

export function ActivityPanel() {
  const [tick, setTick] = useState(0);
  const refresh = useCallback(() => {
    setTick((n) => n + 1);
  }, []);
  void tick;

  const ledger = getSpendingLedger();
  const entries = [...ledger.snapshot().journal].reverse();
  const rows = listBudgetRows(ledger);

  return (
    <section className="panel" aria-labelledby="wallet-activity">
      <div className="panel__head">
        <div>
          <h2 id="wallet-activity">Activity</h2>
          <p className="hint">
            Local journal only. Entries are not chain settlement and do not
            invent refunds.
          </p>
        </div>
        <button type="button" className="btn" onClick={refresh}>
          Refresh
        </button>
      </div>
      <div className="panel__body">
        {entries.length === 0 ? (
          <div className="empty">
            <h3>No wallet activity</h3>
            <p className="hint">
              Reservations and budget opens appear here after Budgets records
              them. Stub — no fabricated history.
            </p>
          </div>
        ) : (
          <>
            <p className="hint">
              {rows.length} budget node{rows.length === 1 ? "" : "s"} ·{" "}
              {entries.length} journal entr{entries.length === 1 ? "y" : "ies"}
            </p>
            <ul className="list">
              {entries.map((entry, index) => (
                <li key={`${entry.kind}-${index}`} className="list__row">
                  <span>{describeEntry(entry)}</span>
                </li>
              ))}
            </ul>
          </>
        )}
      </div>
    </section>
  );
}
