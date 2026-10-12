/** Wallet categories and records use the same subtree navigation as the vault. */
import type { TreeProps } from "@opensesame/app-core/lib/capabilities/runtime-contract.js";
import {
  WALLET_CATEGORIES,
  WALLET_CATEGORY_LABEL,
  walletPath,
} from "@opensesame/app-core/lib/crumbs.js";
import { listSpendingLeases } from "@opensesame/app-core/lib/spending-leases.js";
import {
  formatUnits,
  getSpendingLedger,
  listBudgetRows,
} from "@opensesame/app-core/lib/spending-ledger.js";
import { listPaymentInstruments } from "@opensesame/app-core/lib/wallet-instruments.js";
import { safeMerchantLabel } from "@opensesame/app-core/lib/wallet-safe-label.js";
import { useLocation } from "react-router";
import { PageTreeBranch } from "../../components/PageTreeBranch.js";
import { walletRailPath } from "../../components/record-rail-path.js";
import { pageTabTree } from "../../lib/page-to-tree.js";
import { useVault } from "../../lib/vault/hooks.js";
import {
  useWalletRecords,
  walletRecordPath,
} from "../../sections/wallet/records.js";

export function WalletTree({ pathname }: TreeProps) {
  useWalletRecords();
  const { items } = useVault();
  const { hash } = useLocation();
  const budgets = listBudgetRows().map((row) => ({
    id: row.nodeId,
    label: row.label,
    href: walletRecordPath("/wallet/budgets", row.nodeId),
  }));
  const methods = listPaymentInstruments(items).map((item) => ({
    id: item.id,
    label: item.name,
    href: walletRecordPath(walletPath("methods"), item.id),
  }));
  const passes = [
    ...listSpendingLeases().map((lease) => ({
      id: `lease:${lease.id}`,
      label: `${lease.amount} ${lease.currency} → ${safeMerchantLabel(lease.recipient)}`,
      href: walletRecordPath(walletPath("passes"), `lease:${lease.id}`),
    })),
    ...[...getSpendingLedger().snapshot().attempts.values()]
      .filter((attempt) => attempt.state === "reserved")
      .map((attempt) => ({
        id: `attempt:${attempt.attemptId}`,
        label: `${formatUnits(attempt.amount)} on ${attempt.nodeId}`,
        href: walletRecordPath(
          walletPath("passes"),
          `attempt:${attempt.attemptId}`,
        ),
      })),
  ];
  const records = { budgets, methods, passes };
  const nodes = pageTabTree(
    WALLET_CATEGORIES.map((category) => ({
      id: category,
      label: WALLET_CATEGORY_LABEL[category],
      href: `/wallet/${category}`,
      items: records[category],
    })),
  );
  return (
    <div className="railtree__kids">
      {nodes.map((node) => (
        <PageTreeBranch
          key={node.id}
          node={node}
          level={2}
          current={walletRailPath(pathname, hash)}
        />
      ))}
    </div>
  );
}
