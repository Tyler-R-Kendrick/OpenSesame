/**
 * Wallet management surface (ADR 0123) — overview, budgets, spending passes,
 * payment methods and activity. Honest empty/unavailable stubs only: no
 * fabricated balances, no fake PANs, no Identity API gate.
 */

import { Link, useLocation } from "react-router";
import { EmptyTip, emptyTips } from "../components/EmptyTip.js";
import {
  WALLET_CATEGORIES,
  WALLET_CATEGORY_LABEL,
  type WalletCategory,
  walletCategoryFromLocation,
  walletPath,
} from "../lib/crumbs.js";
import { useVault } from "../lib/vault/hooks.js";
import "./settings.css";
import {
  formatUnits,
  getSpendingLedger,
  listBudgetRows,
} from "../lib/spending-ledger.js";
import { ActivityPanel } from "./wallet/ActivityPanel.js";
import { BudgetsPanel } from "./wallet/BudgetsPanel.js";
import { MethodsPanel } from "./wallet/MethodsPanel.js";
import { PassesPanel } from "./wallet/PassesPanel.js";
import { TemporaryCardPanel } from "./wallet/TemporaryCardPanel.js";

function CategoryLink({
  category,
  current,
}: {
  category: WalletCategory;
  current: boolean;
}) {
  return (
    <Link
      to={walletPath(category)}
      className="set__nav-link"
      aria-current={current ? "page" : undefined}
    >
      {WALLET_CATEGORY_LABEL[category]}
    </Link>
  );
}

export function WalletSection() {
  const { pathname } = useLocation();
  const { guest } = useVault();
  const category = walletCategoryFromLocation(pathname);

  return (
    <div className="section__inner">
      <div className="section__head">
        <h1>Wallet</h1>
      </div>

      <nav className="set__nav" aria-label="Wallet sections">
        {WALLET_CATEGORIES.map((id) => (
          <CategoryLink key={id} category={id} current={category === id} />
        ))}
      </nav>

      {category === "overview" ? <OverviewPanel guest={guest} /> : null}
      {category === "budgets" ? <BudgetsPanel /> : null}
      {category === "passes" ? <PassesPanel /> : null}
      {category === "methods" ? <MethodsPanel /> : null}
      {category === "activity" ? <ActivityPanel /> : null}
    </div>
  );
}

function OverviewPanel({ guest }: { guest: boolean }) {
  const rows = listBudgetRows(getSpendingLedger());
  const roots = rows.filter((row) => row.parentId === null);

  return (
    <>
      <section className="panel">
        <div className="panel__head">
          <div>
            <h2>Spending overview</h2>
          </div>
        </div>
        <div className="panel__body">
          {roots.length === 0 ? (
            <div className="empty">
              <h3>No spending balances</h3>
              <p className="hint">
                Open Budgets to create a conserved local ledger. This screen
                does not invent amounts or claim offline settlement.
              </p>
              {guest ? (
                <p className="hint">
                  Guest session — Wallet is open locally on this device and does
                  not need an Identity API.
                </p>
              ) : null}
              <EmptyTip>{emptyTips.rail}</EmptyTip>
            </div>
          ) : (
            <ul className="list">
              {roots.map((row) => (
                <li key={row.nodeId} className="list__row">
                  <div>
                    <strong>{row.label}</strong>
                    <span className="hint"> · local ledger · not settled</span>
                    <p className="hint">
                      ceiling {formatUnits(row.ceiling)} · available{" "}
                      {formatUnits(row.locallyAvailable)} · reserved{" "}
                      {formatUnits(row.reservedToChildren)} · exposure{" "}
                      {formatUnits(row.unresolvedExternalExposure)} · posted{" "}
                      {formatUnits(row.postedSpending)}
                    </p>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      </section>

      <TemporaryCardPanel />

      <section className="panel">
        <div className="panel__head">
          <div>
            <h2>What Wallet manages</h2>
          </div>
        </div>
        <div className="panel__body">
          <p className="hint">
            Budgets use a conserved local ledger. Spending passes list reserved
            authority. Payment methods stay metadata-only without an issuer.
            Nothing here moves real funds or claims offline settlement.
          </p>
        </div>
      </section>
    </>
  );
}
