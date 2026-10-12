import { useEffect, useSyncExternalStore } from "react";
import type { IdentityView } from "./identity-views.js";

export type HostedIdentityRow = { id: string; label: string };
/** Finite section views own their published rows; this is no arbitrary dictionary. */
export interface HostedIdentityRows {
  people?: readonly HostedIdentityRow[];
  agents?: readonly HostedIdentityRow[];
  providers?: readonly HostedIdentityRow[];
  devices?: readonly HostedIdentityRow[];
  "service-accounts"?: readonly HostedIdentityRow[];
  organization?: readonly HostedIdentityRow[];
}
let snapshot: HostedIdentityRows = {};
const listeners = new Set<() => void>();
function publish(
  view: IdentityView,
  rows: readonly HostedIdentityRow[] | undefined,
) {
  snapshot = { ...snapshot, [view]: rows };
  for (const listener of listeners) listener();
}
/** Publish only the directory data its session-scoped panel has loaded. */
export function usePublishHostedIdentityRows(
  view: IdentityView,
  rows: readonly HostedIdentityRow[],
) {
  useEffect(() => {
    publish(view, rows);
  }, [view, rows]);
  useEffect(
    () => () => {
      publish(view, undefined);
    },
    [view],
  );
}
function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
export function useHostedIdentityRows() {
  return useSyncExternalStore(subscribe, () => snapshot);
}
