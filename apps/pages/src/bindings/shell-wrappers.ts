/** Preserve approved visual ancestry while the same capability renews its lease. */
import { liveRegistrations } from "@opensesame/app-core/lib/capabilities/registry.js";
import type { ShellWrapperContribution } from "@opensesame/app-core/lib/capabilities/runtime-contract.js";
import type { CapabilityId } from "@opensesame/capability-composition";
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { shellReadySeams } from "./shell-ready.js";

type OwnedWrapper = Readonly<{
  capability: CapabilityId;
  entry: ShellWrapperContribution;
}>;
const subscribe = (listener: () => void) =>
  shellReadySeams.subscribeActivated(listener);
const read = () => shellReadySeams.activatedGeneration();

/**
 * Revocation removes registry entries synchronously, before sequential activation
 * replaces them. Removing a still-approved wrapper destroys every draft beneath
 * it. Retain only that presentation, with its proven original capability owner,
 * until renewal completes or the existing bounded shell wait expires. This does
 * not retain registrations, leases, command paths, or withdrawn capabilities.
 * The owning AppVaultShell is keyed to the unlocked vault; lock drops this cache.
 */
export function useRenewingShellWrappers(
  current: readonly ShellWrapperContribution[],
) {
  const snapshot = shellReadySeams.useComposition();
  const activated = useSyncExternalStore(subscribe, read, read);
  const held = useRef<readonly OwnedWrapper[]>([]);
  const heldScope = useRef<string | null>(null);
  const identity = snapshot.plan?.identity;
  const scope = identity
    ? JSON.stringify([
        identity.instanceId,
        identity.installationId,
        identity.vaultId,
        identity.distributionId,
      ])
    : null;
  const [expired, setExpired] = useState<number | null>(null);
  const pending = snapshot.plan !== null && activated !== snapshot.generation;
  useEffect(() => {
    if (!pending) return;
    const generation = snapshot.generation;
    const timer = setTimeout(
      () => setExpired(generation),
      shellReadySeams.maxWaitMs,
    );
    return () => clearTimeout(timer);
  }, [pending, snapshot.generation]);
  useLayoutEffect(() => {
    if (pending && expired !== snapshot.generation) return;
    heldScope.current = scope;
    held.current = liveRegistrations("shell-wrapper", (entry) =>
      current.includes(entry),
    ).map(({ capability, entry }) => ({ capability, entry }));
  }, [pending, expired, snapshot.generation, current, scope]);
  if (
    !pending ||
    expired === snapshot.generation ||
    heldScope.current !== scope
  )
    return current;
  const approved = snapshot.plan?.policyValid
    ? snapshot.plan.capabilities
    : undefined;
  const ids = new Set(current.map((entry) => entry.id));
  const retained = held.current.filter(
    ({ capability, entry }) =>
      approved?.[capability]?.approved === true && !ids.has(entry.id),
  );
  return [...current, ...retained.map(({ entry }) => entry)];
}
