/**
 * Wallet › Payment methods — vault cards and bank accounts.
 */

import { listBudgetRows } from "@opensesame/app-core/lib/spending-ledger.js";
import {
  assignInstrumentBudget,
  budgetIdForInstrument,
} from "@opensesame/app-core/lib/wallet-assignments.js";
import {
  listPaymentInstruments,
  paymentInstrumentDetail,
  paymentInstrumentKindLabel,
} from "@opensesame/app-core/lib/wallet-instruments.js";
import { useCallback, useState } from "react";
import { Link } from "react-router";
import { IconPlus } from "../../components/Icons.js";
import { useVault } from "../../lib/vault/hooks.js";

export function MethodsPanel() {
  const { items } = useVault();
  const [tick, setTick] = useState(0);
  const refresh = useCallback(() => {
    setTick((n) => n + 1);
  }, []);
  void tick;

  const rows = listPaymentInstruments(items);
  const budgets = listBudgetRows();

  return (
    <section className="panel" aria-labelledby="wallet-methods">
      <div className="panel__head">
        <div>
          <h2 id="wallet-methods">Payment methods</h2>
        </div>
        <fieldset className="vtree__keys" aria-label="Payment method commands">
          <Link
            className="icon-btn icon-btn--sm"
            to="/vault/new/card"
            aria-label="Add card"
            title="Add card"
          >
            <IconPlus size={15} />
          </Link>
        </fieldset>
      </div>
      <div className="panel__body">
        {rows.length === 0 ? (
          <div className="empty">
            <h3>No payment methods yet</h3>
          </div>
        ) : (
          <ul className="identity-rows">
            {rows.map((item) => {
              const budgetId = budgetIdForInstrument(item.id);
              return (
                <li key={item.id} className="identity-row">
                  <div className="identity-row__main">
                    <div className="identity-row__id">
                      <h3>
                        <Link to={`/vault/${item.id}`}>{item.name}</Link>
                      </h3>
                      <span className="identity-ref">
                        {paymentInstrumentKindLabel(item)}
                        {paymentInstrumentDetail(item)
                          ? ` · ${paymentInstrumentDetail(item)}`
                          : ""}
                      </span>
                    </div>
                    <label className="field">
                      <span className="label">Budget</span>
                      <select
                        aria-label={`Budget for ${item.name}`}
                        value={budgetId ?? ""}
                        onChange={(event) => {
                          assignInstrumentBudget(
                            item.id,
                            event.target.value || null,
                          );
                          refresh();
                        }}
                      >
                        <option value="">None</option>
                        {budgets.map((budget) => (
                          <option key={budget.nodeId} value={budget.nodeId}>
                            {budget.label}
                          </option>
                        ))}
                      </select>
                    </label>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </section>
  );
}
