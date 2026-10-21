import { subscribeLocalIamChanges } from "@opensesame/app-core/lib/local-iam-events.js";
import { listLocalShares } from "@opensesame/app-core/lib/local-share-grants.js";
import { useEffect, useState } from "react";

/** Test seams: the vault does not have to reach sealed storage to draw a row. */
export const sharedItemsSeams = {
  list: listLocalShares,
  subscribe: subscribeLocalIamChanges,
};

/**
 * How many standing item grants point at each item, for the vault list.
 *
 * The share ledger is the authority. A secret's `grantees` field records a
 * different kind of agent access, so reading only that field misses an item
 * a person just granted through Access.
 */
export function useSharedItems(tomb: string): ReadonlyMap<string, number> {
  const [shared, setShared] = useState<ReadonlyMap<string, number>>(
    () => new Map(),
  );

  useEffect(() => {
    if (!tomb) {
      setShared(new Map());
      return;
    }
    let live = true;
    let generation = 0;
    const load = () => {
      const request = ++generation;
      void sharedItemsSeams
        .list(tomb)
        .then((shares) => {
          if (!live || request !== generation) return;
          const counts = new Map<string, number>();
          for (const share of shares) {
            if (share.resourceKind !== "item") continue;
            counts.set(
              share.resourceId,
              (counts.get(share.resourceId) ?? 0) + 1,
            );
          }
          setShared(counts);
        })
        .catch(() => {
          if (!live || request !== generation) return;
          setShared(new Map());
        });
    };
    const stop = sharedItemsSeams.subscribe(load);
    load();
    return () => {
      live = false;
      stop();
    };
  }, [tomb]);

  return shared;
}
