import { type ReactNode, useEffect, useSyncExternalStore } from "react";
import type { Connection, Provider } from "../lib/connections.js";

type Snapshot = {
  providers: Provider[] | null;
  connections: Connection[] | null;
};
const EMPTY: Snapshot = { providers: null, connections: null };

/**
 * One in-memory snapshot shared by the Connections page (which loads it)
 * and the rail tree (which only projects it). A module-level store rather
 * than React context, so the section route and the rail entry the
 * `connectors.external` runtime contributes need no common provider above
 * them in the shell; `resetConnectionsNavigation` empties it on disable.
 */
let snapshot: Snapshot = EMPTY;
const listeners = new Set<() => void>();

function publishConnections(next: Snapshot): void {
  if (
    next.providers === snapshot.providers &&
    next.connections === snapshot.connections
  )
    return;
  snapshot = next;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function read(): Snapshot {
  return snapshot;
}

/** Disable / lock: forget what the page published. */
export function resetConnectionsNavigation(): void {
  publishConnections(EMPTY);
}

/**
 * Kept for callers that still wrap the shell in it; the store above needs
 * no provider, so this only renders its children.
 */
export function ConnectionsNavigation({ children }: { children: ReactNode }) {
  return <>{children}</>;
}

export function useConnectionsNavigation(): Snapshot {
  return useSyncExternalStore(subscribe, read, read);
}

export function usePublishConnections(
  providers: Provider[] | null,
  connections: Connection[] | null,
) {
  useEffect(() => {
    publishConnections({ providers, connections });
  }, [providers, connections]);
  useEffect(() => () => publishConnections(EMPTY), []);
}
