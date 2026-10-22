/**
 * The marks on the right of a vault row: what state the record is in, not what
 * it holds. Kept apart from the tree because these are independent facts
 * about one record, and the tree is already at the module-size budget.
 */
import {
  rotationEventFor,
  subscribeRotationQueue,
} from "@opensesame/app-core/lib/vault/rotation-queue.js";
import type { VaultItem } from "@opensesame/vault-core";
import { useSyncExternalStore } from "react";
import { IconClock, IconPeople, IconStar } from "../../components/Icons.js";
import { formatExpiry } from "./expiry.js";

export function Decorations({
  item,
  sharedGrants = 0,
}: {
  item: VaultItem;
  /** Standing item grants from the local share ledger. */
  sharedGrants?: number;
}) {
  // A record somebody else can open says so on the row with the people it is
  // shared with. The people mark sits last, immediately before the row's
  // `⋯`, so "who can open this" reads as part of the action area.
  const grantees = item.kind === "secret" ? item.grantees : [];
  const shared = sharedGrants > 0 || grantees.length > 0;
  const sharedTitle =
    sharedGrants > 0
      ? `Shared with ${sharedGrants} ${
          sharedGrants === 1 ? "identity" : "identities"
        }`
      : `Shared with ${grantees.join(", ")}`;
  const rotationState = useSyncExternalStore(
    subscribeRotationQueue,
    () => rotationEventFor(item.id)?.state ?? "",
    () => "",
  );
  return (
    <span className="vtree__side">
      {rotationState === "out-of-sync" ? (
        <IconClock
          size={13}
          title="Rotation queued — no relay configured yet"
        />
      ) : null}
      {item.kind === "drop" ? (
        <IconClock
          size={13}
          title={`Expires ${formatExpiry(item.expiresAt)}`}
        />
      ) : null}
      {item.favorite ? (
        <IconStar size={13} filled title="Favorite" className="vtree__fav" />
      ) : null}
      {shared ? (
        <IconPeople size={13} className="vtree__shared" title={sharedTitle} />
      ) : null}
    </span>
  );
}
