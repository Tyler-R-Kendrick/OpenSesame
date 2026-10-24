import { subscribeIdentitySession } from "@opensesame/app-core/lib/identity.js";
import { currentActorPrincipalId } from "@opensesame/app-core/lib/local-actor.js";
import { readLocalDirectory } from "@opensesame/app-core/lib/local-directory.js";
import { ALL_USERS_GROUP_ID } from "@opensesame/app-core/lib/local-groups.js";
import { subscribeLocalIamChanges } from "@opensesame/app-core/lib/local-iam-events.js";
import {
  type LocalShare,
  listLocalShares,
} from "@opensesame/app-core/lib/local-share-grants.js";
import type { VaultItem } from "@opensesame/vault-core";
import { useEffect, useState } from "react";

/** Test seams: the vault does not have to reach sealed storage to draw a row. */
export const sharedItemsSeams = {
  list: listLocalShares,
  actor: currentActorPrincipalId,
  directory: readLocalDirectory,
  subscribe: subscribeLocalIamChanges,
  subscribeIdentity: subscribeIdentitySession,
};

export type SharedBy = {
  id: string;
  name: string;
};

export type SharedItemMark = {
  /** Standing item grants this actor issued to someone else. */
  outgoing: number;
  /** People who shared this item with the actor, or with All users. */
  incoming: readonly SharedBy[];
};

export type SharedItemMarks = ReadonlyMap<string, SharedItemMark>;

type MutableMark = {
  outgoing: number;
  incoming: Map<string, string>;
};

function markOf(
  marks: Map<string, MutableMark>,
  resourceId: string,
): MutableMark {
  const existing = marks.get(resourceId);
  if (existing) return existing;
  const next = { outgoing: 0, incoming: new Map<string, string>() };
  marks.set(resourceId, next);
  return next;
}

function sharedWithActor(share: LocalShare, actorId: string | null): boolean {
  return (
    actorId !== null &&
    (share.principalId === actorId || share.principalId === ALL_USERS_GROUP_ID)
  );
}

function targetIds(
  tomb: string,
  share: LocalShare,
  items: readonly VaultItem[],
): readonly string[] {
  if (share.resourceKind === "item") return [share.resourceId];
  if (share.resourceKind === "folder")
    return items
      .filter((item) => item.folderId === share.resourceId)
      .map((item) => item.id);
  if (share.resourceKind === "vault")
    return share.resourceId === tomb ? items.map((item) => item.id) : [];
  return [];
}

function markShare(
  tomb: string,
  marks: Map<string, MutableMark>,
  share: LocalShare,
  items: readonly VaultItem[],
  actorId: string | null,
  names: ReadonlyMap<string, string>,
): void {
  for (const id of targetIds(tomb, share, items))
    markItem(marks, id, share, actorId, names);
}

function markItem(
  marks: Map<string, MutableMark>,
  resourceId: string,
  share: LocalShare,
  actorId: string | null,
  names: ReadonlyMap<string, string>,
): void {
  const mark = markOf(marks, resourceId);
  if (actorId === null) {
    // A custodian has no person-level attribution: keep the existing count.
    mark.outgoing += 1;
    return;
  }
  if (share.issuedBy === actorId) {
    mark.outgoing += 1;
    return;
  }
  if (sharedWithActor(share, actorId)) {
    const id = share.issuedBy ?? "";
    mark.incoming.set(
      id,
      share.issuedBy
        ? (names.get(share.issuedBy) ?? "Another user")
        : "Another user",
    );
    return;
  }
  // A legacy share to someone else does not name its issuer. It is neither
  // this actor's outgoing grant nor a grant they received, so it stays
  // unattributed rather than becoming a false claim.
}

function finishMarks(marks: Map<string, MutableMark>): SharedItemMarks {
  return new Map(
    [...marks].map(([id, mark]) => [
      id,
      {
        outgoing: mark.outgoing,
        incoming: [...mark.incoming].map(([issuerId, name]) => ({
          id: issuerId,
          name,
        })),
      } satisfies SharedItemMark,
    ]),
  );
}

/**
 * How each item is shared, from this actor's point of view.
 *
 * A person's own grant and a grant they received are different facts. The
 * share ledger records both, plus the issuer where one was present, so the
 * vault can show "Shared by Ada" instead of only counting identities.
 */
export function useSharedItems(
  tomb: string,
  items: readonly VaultItem[] = [],
): SharedItemMarks {
  const [shared, setShared] = useState<SharedItemMarks>(() => new Map());

  useEffect(() => {
    if (!tomb) {
      setShared(new Map());
      return;
    }
    let live = true;
    let generation = 0;
    const load = () => {
      const request = ++generation;
      void Promise.all([
        sharedItemsSeams.list(tomb),
        sharedItemsSeams.actor(tomb),
        sharedItemsSeams.directory(tomb).catch(() => null),
      ])
        .then(([shares, actorId, directory]) => {
          if (!live || request !== generation) return;
          const names = new Map(
            (directory?.entries ?? []).map((entry) => [entry.id, entry.name]),
          );
          const marks = new Map<string, MutableMark>();
          for (const share of shares)
            markShare(tomb, marks, share, items, actorId, names);
          setShared(finishMarks(marks));
        })
        .catch(() => {
          if (!live || request !== generation) return;
          setShared(new Map());
        });
    };
    const stop = sharedItemsSeams.subscribe(load);
    const stopIdentity = sharedItemsSeams.subscribeIdentity(load);
    load();
    return () => {
      live = false;
      stop();
      stopIdentity();
    };
  }, [items, tomb]);

  return shared;
}
