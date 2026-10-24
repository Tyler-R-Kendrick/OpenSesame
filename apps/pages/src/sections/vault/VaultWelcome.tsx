import { vaultFilterLabel } from "@opensesame/app-core/lib/crumbs.js";
import { resolveFilterSlug } from "@opensesame/app-core/lib/vault-filter-slug.js";
import { itemTypeId, listedItems } from "@opensesame/vault-core";
import { useSearchParams } from "react-router";
import { EmptyTip } from "../../components/EmptyTip.js";
import { useVault, useVaultStore } from "../../lib/vault/hooks.js";
import { WelcomeKeys } from "./WelcomeKeys.js";
import { useSharedItems } from "./use-shared-items.js";

/**
 * The buffer before the cursor lands on a file. No dashboard: moving the
 * cursor previews items, so this pane only states what the list beside it
 * holds and hands over the keys for the filter the list is showing.
 */
export function VaultWelcome() {
  const { items } = useVault();
  const store = useVaultStore();
  const sharedItems = useSharedItems(store.activeTomb?.() ?? "", items);
  const [params] = useSearchParams();
  const filter = resolveFilterSlug(params.get("f") ?? "all");
  const inTrash = filter === "trash";
  const incoming = (id: string) => sharedItems.get(id)?.incoming.length ?? 0;
  const shown = listedItems(items).filter((item) => {
    if (inTrash) return item.deletedAt !== null;
    if (item.deletedAt !== null) return false;
    if (filter === "favorites") return item.favorite;
    if (filter === "shared") return incoming(item.id) > 0;
    if (filter === "owned") return incoming(item.id) === 0;
    return filter === "all" || itemTypeId(item) === filter;
  });
  const what =
    filter === "all"
      ? null
      : filter === "shared"
        ? "shared items"
        : filter === "owned"
          ? "owned items"
          : (vaultFilterLabel(filter) ?? filter).toLowerCase();

  if (shown.length === 0) {
    // The list pane states the empty list and carries the actions that fill
    // it. The buffer says what is there and hands over the keys — the same
    // two mono lines it shows a full vault (DESIGN.md § Empty states).
    return (
      <div className="buffer">
        <p className="buffer__line">
          {inTrash
            ? "trash is empty"
            : what
              ? `no ${what} yet`
              : "nothing sealed yet"}
        </p>
        <WelcomeKeys inTrash={inTrash} empty />
      </div>
    );
  }

  return (
    <div className="buffer">
      <p className="buffer__line">
        {shown.length} {shown.length === 1 ? "item" : "items"}
        {what ? ` · ${what}` : ""}
      </p>
      <EmptyTip tip="vaultMove" />
      <WelcomeKeys inTrash={inTrash} empty={false} />
    </div>
  );
}
