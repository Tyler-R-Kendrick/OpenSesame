/**
 * The wallet's rail entries — one row per category (budgets, payment
 * methods, spending passes). Moved out of `AppShell`'s `NavTree` so the
 * shell draws them only while `wallet.spending` is active.
 */

import type { TreeProps } from "@opensesame/app-core/lib/capabilities/runtime-contract.js";
import {
  WALLET_CATEGORIES,
  WALLET_CATEGORY_LABEL,
  walletCategoryFromLocation,
  walletPath,
} from "@opensesame/app-core/lib/crumbs.js";
import { PageTreeLeafRow } from "../../components/PageTreeBranch.js";

export function WalletTree({ pathname }: TreeProps) {
  const current = walletPath(walletCategoryFromLocation(pathname));
  return (
    <div className="railtree__kids">
      {WALLET_CATEGORIES.map((category) => (
        <PageTreeLeafRow
          key={category}
          node={{
            id: category,
            label: WALLET_CATEGORY_LABEL[category],
            href: walletPath(category),
            children: [],
            branch: false,
          }}
          level={2}
          current={current}
        />
      ))}
    </div>
  );
}
