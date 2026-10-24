/** A command belongs to the completed activation pass in which it began. */
import {
  activatedGeneration,
  subscribeActivated,
} from "@opensesame/app-core/lib/capabilities/change.js";
import { leaseIsCurrent } from "@opensesame/app-core/lib/capabilities/lease.js";
import { compositionStore } from "@opensesame/app-core/lib/capabilities/store.js";
import { useEffect, useRef, useSyncExternalStore } from "react";
import { useComposition } from "../bindings/capabilities.js";

export function useCommandActivation() {
  const snapshot = useComposition();
  const activated = useSyncExternalStore(
    subscribeActivated,
    activatedGeneration,
    activatedGeneration,
  );
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const ready = snapshot.plan === null || snapshot.generation === activated;
  const capture = () => {
    const original = compositionStore.getSnapshot();
    if (original.plan !== null && activatedGeneration() !== original.generation)
      return null;
    const lease =
      original.plan === null ? null : compositionStore.currentLease();
    return () =>
      mounted.current &&
      compositionStore.getSnapshot().generation === original.generation &&
      (lease === null ||
        leaseIsCurrent(lease, compositionStore.getSnapshot().generation));
  };
  return { ready, capture };
}
