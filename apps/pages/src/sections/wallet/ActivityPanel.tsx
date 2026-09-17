/**
 * Wallet › Activity — local budget journal.
 */

import type { JournalEntry } from "@opensesame/wallet-budget";
import { useCallback, useState } from "react";
import { IconRefresh } from "../../components/Icons.js";
import { formatUnits, getSpendingLedger } from "../../lib/spending-ledger.js";

function describeEntry(entry: JournalEntry): string {
  switch (entry.kind) {
    case "node_opened":
      return `${entry.nodeId} opened`;
    case "exclusive_allocated":
      return `${formatUnits(entry.amount)} → ${entry.childId}`;
    case "reserved":
      return `${formatUnits(entry.amount)} reserved`;
    case "committed":
      return `${entry.attemptId} committed`;
    case "released":
      return `${entry.attemptId} released`;
    case "ceiling_set":
      return `${entry.nodeId} ceiling ${formatUnits(entry.ceiling)}`;
    case "node_closed":
      return `${entry.nodeId} removed`;
  }
}

export function ActivityPanel() {
  const [tick, setTick] = useState(0);
  const refresh = useCallback(() => {
    setTick((n) => n + 1);
  }, []);
  void tick;

  const entries = [...getSpendingLedger().snapshot().journal].reverse();

  return (
    <section className="panel" aria-labelledby="wallet-activity">
      <div className="panel__head">
        <div>
          <h2 id="wallet-activity">Activity</h2>
        </div>
        <fieldset className="vtree__keys" aria-label="Activity commands">
          <button
            type="button"
            className="icon-btn icon-btn--sm"
            aria-label="Refresh"
            title="Refresh"
            onClick={refresh}
          >
            <IconRefresh size={15} />
          </button>
        </fieldset>
      </div>
      <div className="panel__body">
        {entries.length === 0 ? (
          <div className="empty">
            <h3>No activity yet</h3>
          </div>
        ) : (
          <ul className="identity-rows">
            {entries.map((entry, index) => (
              <li key={`${entry.kind}-${index}`} className="identity-row">
                <div className="identity-row__main">
                  <div className="identity-row__id">
                    <h3>{describeEntry(entry)}</h3>
                  </div>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}
