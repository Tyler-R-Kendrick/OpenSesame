/**
 * The marks on the right of a vault row: what state the record is in, not what
 * it holds. Kept apart from the tree because these are independent facts
 * about one record, and the tree is already at the module-size budget.
 */
import {
  subscribeVaultResetRuns,
  vaultResetRunFor,
} from "@opensesame/app-core/lib/password-reset/vault-run-tracker.js";
import {
  rotationEventFor,
  subscribeRotationQueue,
} from "@opensesame/app-core/lib/vault/rotation-queue.js";
import type { VaultItem } from "@opensesame/vault-core";
import { useSyncExternalStore } from "react";
import { IconClock, IconPeople, IconStar } from "../../components/Icons.js";
import { useVaultStore } from "../../lib/vault/hooks.js";
import { formatExpiry } from "./expiry.js";
import type { SharedItemMark } from "./use-shared-items.js";

function plural(count: number): string {
  return count === 1 ? "identity" : "identities";
}

export function Decorations({
  item,
  shared,
}: {
  item: VaultItem;
  /** How this item is shared, from the current actor's point of view. */
  shared?: SharedItemMark;
}) {
  // A record somebody else can open says so on the row with the person who
  // shared it. A grant this actor issued stays a count: it is their own act,
  // not a thing received from another user.
  const grantees = item.kind === "secret" ? item.grantees : [];
  const scope = useVaultStore().activeTomb?.() ?? "";
  const rotationState = useSyncExternalStore(
    subscribeRotationQueue,
    () => rotationEventFor(scope, item.id)?.state ?? "",
    () => "",
  );
  const resetRunPhase = useSyncExternalStore(
    subscribeVaultResetRuns,
    () => vaultResetRunFor(scope, item.id)?.phase ?? "",
    () => "",
  );
  const incoming = shared?.incoming ?? [];
  const outgoing = shared?.outgoing ?? 0;
  const sharedNotes = [
    incoming.length > 0
      ? `Shared by ${incoming.map((person) => person.name).join(", ")}`
      : null,
    outgoing > 0 ? `Shared with ${outgoing} ${plural(outgoing)}` : null,
    grantees.length > 0 ? `Shared with ${grantees.join(", ")}` : null,
  ].filter((note): note is string => note !== null);
  const sharedTitle = sharedNotes.join(" · ");
  const sharerLabel =
    incoming.length === 0
      ? null
      : incoming.length === 1
        ? `Shared by ${incoming[0]?.name}`
        : `Shared by ${incoming[0]?.name} +${incoming.length - 1}`;
  return (
    <span className="vtree__side">
      {resetRunPhase === "needs-you" ? (
        <IconClock size={13} title="Password reset needs you" />
      ) : resetRunPhase === "in-progress" || resetRunPhase === "queued" ? (
        <IconClock size={13} title="Password reset in progress" />
      ) : rotationState === "out-of-sync" ? (
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
      {sharerLabel ? (
        <span className="vtree__sharer" title={sharedTitle}>
          {sharerLabel}
        </span>
      ) : null}
      {sharedNotes.length > 0 ? (
        <IconPeople
          size={13}
          className="vtree__shared"
          title={sharerLabel ? undefined : sharedTitle}
        />
      ) : null}
    </span>
  );
}
