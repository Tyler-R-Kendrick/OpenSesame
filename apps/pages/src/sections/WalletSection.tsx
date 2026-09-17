/**
 * Wallet — budgets, payment methods, spending passes, and activity.
 */

import { Link, useLocation } from "react-router";
import {
  WALLET_CATEGORIES,
  WALLET_CATEGORY_LABEL,
  type WalletCategory,
  walletCategoryFromLocation,
  walletPath,
} from "../lib/crumbs.js";
import "./identity.css";
import "./settings.css";
import { ActivityPanel } from "./wallet/ActivityPanel.js";
import { BudgetsPanel } from "./wallet/BudgetsPanel.js";
import { MethodsPanel } from "./wallet/MethodsPanel.js";
import { PassesPanel } from "./wallet/PassesPanel.js";

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

      {category === "budgets" ? <BudgetsPanel /> : null}
      {category === "passes" ? <PassesPanel /> : null}
      {category === "methods" ? <MethodsPanel /> : null}
      {category === "activity" ? <ActivityPanel /> : null}
    </div>
  );
}
