import {
  WALLET_CATEGORIES,
  WALLET_CATEGORY_LABEL,
  walletCategoryFromLocation,
  walletPath,
} from "../lib/crumbs.js";
import { PageTreeLeafRow } from "./PageTreeBranch.js";
import { SectionRow, type SectionTreeProps } from "./RailRows.js";

/**
 * The wallet's rail subtree: one leaf per category. The `wallet.spending`
 * module registers this as its section contribution's `Tree`; the core shell
 * draws nothing wallet-shaped on its own.
 */
export function WalletTree({
  section,
  open,
  active,
  onToggle,
  pathname,
}: SectionTreeProps) {
  const current = walletPath(walletCategoryFromLocation(pathname));
  return (
    <>
      <SectionRow
        section={section}
        open={open}
        active={active}
        branch={open}
        onToggle={onToggle}
      />
      {open ? (
        <div className="railtree__kids" id="wallet-tree">
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
      ) : null}
    </>
  );
}
