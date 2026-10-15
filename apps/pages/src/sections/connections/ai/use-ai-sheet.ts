/**
 * The Add-a-model-provider sheet over the Connections page (ADR 0192): which
 * provider's connections the route is about, whether it opens the sheet rather
 * than a page of its own, and where closing it or connecting lands.
 */
import type {
  Connection,
  Provider,
} from "@opensesame/app-core/lib/connections.js";
import {
  connectionRouteMatches,
  connectionRouteProvider,
} from "@opensesame/app-core/sections/connections/provider-route.js";
import type { Flash } from "@opensesame/app-core/sections/connections/shared.js";
import { useEffect, useState } from "react";
import { useNavigate } from "react-router";
import { aiProviderSheetTarget } from "./ai-provider-sheet-target.js";

type Options = Readonly<{
  providerId: string | undefined;
  connectionId: string | undefined;
  pathname: string;
  providers: readonly Provider[] | null;
  /** `null` until the list has loaded: no sheet is decided before then. */
  connections: readonly Connection[] | null;
  reload: () => Promise<void>;
  /** Raises a flash on the page the section is showing when it is called. */
  onFlash: (flash: Flash) => void;
}>;

export function useAiSheet({
  providerId,
  connectionId,
  pathname,
  providers,
  connections,
  reload,
  onFlash,
}: Options) {
  const navigate = useNavigate();
  const provider = connectionRouteProvider(providers, providerId);
  const providerConnections = (connections ?? []).filter(
    (item) =>
      connectionRouteMatches(item.providerId, providerId) &&
      item.status !== "revoked",
  );
  // The route decides once, on arrival, whether it is a first connection (the
  // sheet) or a connection's page. Removing the connection from its page leaves
  // that page where it is: the person did not ask to add it again.
  const [arrival, setArrival] = useState<Readonly<{
    providerId: string;
    onPage: boolean;
  }> | null>(null);
  if (!providerId && arrival) setArrival(null);
  else if (
    providerId &&
    connections !== null &&
    arrival?.providerId !== providerId
  )
    setArrival({ providerId, onPage: providerConnections.length > 0 });
  // What connecting says belongs to the page it lands on. A flash is read back
  // only on the scope that raised it, and this route's scope is the provider's,
  // which the landing leaves: so it is held until the list is showing, raised
  // there, and dropped if the person goes to another provider instead.
  const [landing, setLanding] = useState<Readonly<{
    providerId: string;
    flash: Flash;
  }> | null>(null);
  useEffect(() => {
    if (!landing) return;
    if (!providerId) {
      onFlash(landing.flash);
      setLanding(null);
    } else if (providerId !== landing.providerId) setLanding(null);
  }, [landing, providerId, onFlash]);
  const target =
    providerId && connections !== null && arrival?.onPage !== true
      ? aiProviderSheetTarget({
          provider,
          connections: providerConnections,
          connectionId,
          pathname,
        })
      : null;
  return {
    provider,
    providerConnections,
    target,
    close: () => navigate("/connections"),
    connected: (flash: Flash) => {
      if (providerId) setLanding({ providerId, flash });
      void reload();
      navigate("/connections");
    },
  };
}
