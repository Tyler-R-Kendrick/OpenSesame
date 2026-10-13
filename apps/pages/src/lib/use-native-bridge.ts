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
