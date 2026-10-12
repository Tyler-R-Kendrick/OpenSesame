/** Wallet uses the same list-and-record workspace as the vault. */
import { walletCategoryFromLocation } from "@opensesame/app-core/lib/crumbs.js";
import { useLocation } from "react-router";
import { BudgetsPanel } from "./wallet/BudgetsPanel.js";
import { MethodsPanel } from "./wallet/MethodsPanel.js";
import { PassesPanel } from "./wallet/PassesPanel.js";

export function WalletSection() {
  const { pathname } = useLocation();
  const category = walletCategoryFromLocation(pathname);
  if (category === "passes") return <PassesPanel />;
  if (category === "methods") return <MethodsPanel />;
  return <BudgetsPanel />;
}
