import { mergeLocalGitConnections } from "@opensesame/app-core/lib/connections-local-git.js";
import {
  type Connection,
  type Provider,
  listConnections,
} from "@opensesame/app-core/lib/connections.js";
import { getBundledProviders } from "@opensesame/app-core/lib/embedded-catalog.js";
import { vercelCatalogSeams } from "@opensesame/app-core/lib/vercel-connect-catalog.js";
import {
  type ReactNode,
  useEffect,
  useState,
  useSyncExternalStore,
} from "react";

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

/**
 * What the rail's connections/ entries draw from: the page's snapshot while
 * the page is open, and otherwise a read of its own — the same bundled
 * catalog and the same connection list. Before, the rail had only what the
 * page published, so everywhere but /connections it said "Loading
 * connectors…" forever and "No connected services" beside a page that had
 * some.
 */
export function useRailConnections(): Snapshot {
  const published = useConnectionsNavigation();
  const [own, setOwn] = useState<Snapshot>(EMPTY);
  useEffect(() => {
    if (published.providers !== null) return;
    let live = true;
    const providers = vercelCatalogSeams.providers(getBundledProviders());
    setOwn({ providers, connections: null });
    void listConnections()
      .catch(() => mergeLocalGitConnections([]))
      .then((connections) => {
        if (live) setOwn({ providers, connections });
      });
    return () => {
      live = false;
    };
  }, [published.providers]);
  return published.providers !== null ? published : own;
}
