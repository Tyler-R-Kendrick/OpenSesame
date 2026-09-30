import type { VaultItem } from "@opensesame/vault-core";
import { useContributions } from "../../bindings/contributions.js";

/**
 * What the vault's item pages draw from other capabilities: a contributed
 * kind's record view (a legacy drop, `sharing.drops`), offers to share any
 * stored item, and suggestions for a new item's labels (the
 * on-device model, `support.local-ai`). Absent, the page draws none of them.
 */
export function useEditorContributions(kind: string | undefined) {
  const kinds = useContributions("item-kind");
  const [assist] = useContributions("item-draft-assist");
  return {
    Create: kinds.find((entry) => entry.kind === kind && entry.Create)?.Create,
    Suggestions: assist?.Suggestions,
  };
}

/** The record view the item's kind contributes, if its capability is on. */
export function KindRecord({ item }: { item: VaultItem }) {
  const Record = useContributions("item-kind").find(
    (entry) => entry.kind === item.kind && entry.Record,
  )?.Record;
  return Record ? <Record item={item} /> : null;
}

/** Every offer to share this item, in contribution order. */
export function SecretShares({
  item,
  initialOpen,
}: {
  item: VaultItem;
  initialOpen?: boolean;
}) {
  const shares = useContributions("secret-share");
  return (
    <>
      {shares.map(({ id, Panel }) => (
        <Panel key={id} item={item} initialOpen={initialOpen} />
      ))}
    </>
  );
}
