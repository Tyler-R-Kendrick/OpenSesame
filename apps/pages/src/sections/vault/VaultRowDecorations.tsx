/**
 * The marks on the right of a vault row: what state the record is in, not what
 * it holds. Kept apart from the tree because these are four independent facts
 * about one record, and the tree is already at the module-size budget.
 */
import type { VaultItem } from "@opensesame/vault-core";
import { IconClock, IconShare, IconStar } from "../../components/Icons.js";
import { formatExpiry } from "./expiry.js";

export function Decorations({ item }: { item: VaultItem }) {
  // A secret somebody else can open says so on the row: the grant is standing,
  // it outlives the ceremony that made it, and the list is where a person
  // looks for "what have I handed out". The drop beside it is the other way
  // out and already carries its own clock.
  const shared = item.kind === "secret" && item.grantees.length > 0;
  return (
    <span className="vtree__side">
      {item.kind === "drop" ? (
        <IconClock
          size={13}
          title={`Expires ${formatExpiry(item.expiresAt)}`}
        />
      ) : null}
      {shared ? (
        <IconShare
          size={13}
          title={`Shared with ${item.grantees.join(", ")}`}
        />
      ) : null}
      {item.favorite ? (
        <IconStar size={13} filled title="Favorite" className="vtree__fav" />
      ) : null}
    </span>
  );
}
