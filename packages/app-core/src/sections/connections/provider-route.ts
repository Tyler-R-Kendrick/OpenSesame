import type { Provider } from "../../lib/connections.js";
import { canonicalProviderId } from "../../lib/connector-catalog.js";

/** Resolve deep links without changing the catalog id used by saved records. */
export function connectionRouteProvider(
  providers: readonly Provider[] | null,
  providerId: string | undefined,
): Provider | null {
  if (!providers || !providerId) return null;
  const exact = providers.find((provider) => provider.id === providerId);
  if (exact) return exact;
  const canonical = canonicalProviderId(providerId);
  if (!canonical) return null;
  return (
    providers.find(
      (provider) => canonicalProviderId(provider.id) === canonical,
    ) ?? null
  );
}

/** A canonical deep link includes connections saved under its catalog alias. */
export function connectionRouteMatches(
  providerId: string,
  routeId: string | undefined,
): boolean {
  if (providerId === routeId) return true;
  if (!routeId) return false;
  const canonical = canonicalProviderId(routeId);
  return (
    canonical !== undefined && canonicalProviderId(providerId) === canonical
  );
}
