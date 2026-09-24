import { readLocalDirectory } from "@opensesame/app-core/lib/local-directory.js";
import {
  type LocalShare,
  policyLabel,
} from "@opensesame/app-core/lib/local-share-grants.js";
import { useEffect, useState } from "react";
import { useLocalShares } from "./LocalSharePanel.js";

/**
 * A share as the rail names it: as its card does, `guest-1 → GitHub`, with
 * the policy only where two shares would otherwise read the same. Named by
 * resource alone (`vault: guest-1`), three different shares were three
 * identical rows.
 */
export function shareLeafLabels(
  shares: readonly LocalShare[],
  names: ReadonlyMap<string, string>,
): { id: string; label: string }[] {
  const title = (share: LocalShare) =>
    `${names.get(share.principalId) ?? share.principalId} → ${share.resourceLabel}`;
  const seen = new Map<string, number>();
  for (const share of shares) {
    seen.set(title(share), (seen.get(title(share)) ?? 0) + 1);
  }
  return shares.map((share) => ({
    id: share.id,
    label:
      (seen.get(title(share)) ?? 0) > 1
        ? `${title(share)} · ${policyLabel(share.resourceKind, share.policy)}`
        : title(share),
  }));
}

/** The rail's share leaves for a tomb, with the directory's names. */
export function useShareLeaves(tomb: string) {
  const { shares } = useLocalShares(tomb);
  const [names, setNames] = useState<ReadonlyMap<string, string>>(new Map());
  useEffect(() => {
    let live = true;
    void readLocalDirectory(tomb)
      .then((directory) => {
        if (live) {
          setNames(
            new Map(directory.entries.map((entry) => [entry.id, entry.name])),
          );
        }
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [tomb]);
  return shareLeafLabels(shares, names);
}
