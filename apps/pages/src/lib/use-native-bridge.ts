import {
  type BridgeSnapshot,
  askBridgeFor,
  bridgeGuidance,
  nativeBridgeStore,
} from "@opensesame/app-core/lib/native-bridge.js";
import { useEffect, useSyncExternalStore } from "react";

/**
 * The connector bridge (ADR 0199), as a component sees it: re-rendered when the
 * extension appears, or a host is allowed in it. For a provider that needs the
 * bridge, once the bridge is there but does not hold the provider's host, the
 * host is put in the bridge's popup, ready to allow; asking allows nothing.
 */
export function useNativeBridge(providerId?: string): BridgeSnapshot {
  const snapshot = useSyncExternalStore(
    nativeBridgeStore.subscribe,
    nativeBridgeStore.getSnapshot,
    nativeBridgeStore.getSnapshot,
  );
  const needsHost =
    providerId !== undefined &&
    snapshot.present &&
    bridgeGuidance(providerId)?.state === "needs-host";
  useEffect(() => {
    if (needsHost && providerId) void askBridgeFor(providerId);
  }, [needsHost, providerId]);
  return snapshot;
}

/** The form fields a person types their own tenant host into (ADR 0217). */
const TENANT_FIELDS = [
  "token_endpoint",
  "resource",
  "revocation_endpoint",
  "domain",
  "shop",
  "ui_host",
  "api_host",
] as const;

/** The hosts a person has typed into the form, as lower-case host names: public fields only, never a secret. */
export function typedHosts(values: Readonly<Record<string, string>>): string[] {
  const found = new Set<string>();
  for (const field of TENANT_FIELDS) {
    const raw = values[field]?.trim().toLowerCase();
    if (!raw) continue;
    try {
      const host = new URL(raw.includes("://") ? raw : `https://${raw}`)
        .hostname;
      if (host.includes(".")) found.add(host);
    } catch {
      // Not an address yet: the person is still typing.
    }
  }
  return [...found].sort();
}

/**
 * A provider whose OAuth application lives at the person's own tenant is
 * carried at a host only they can name. Once they have typed it and the bridge
 * is there, put it in the bridge's popup, ready to allow; asking allows nothing.
 */
export function useBridgeTenantAsk(
  providerId: string,
  values: Readonly<Record<string, string>>,
): void {
  const snapshot = useSyncExternalStore(
    nativeBridgeStore.subscribe,
    nativeBridgeStore.getSnapshot,
    nativeBridgeStore.getSnapshot,
  );
  const hosts = typedHosts(values).join(" ");
  useEffect(() => {
    if (snapshot.present && hosts)
      void askBridgeFor(providerId, hosts.split(" "));
  }, [snapshot.present, providerId, hosts]);
}
