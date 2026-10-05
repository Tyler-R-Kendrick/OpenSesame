import {
  type PackSnapshot,
  getPackSnapshot,
  subscribePackState,
} from "@opensesame/app-core/lib/type-packs/state.js";
import { useSyncExternalStore } from "react";

/** The item-type packs' state (ADR 0165); re-renders only when it moves. */
export function usePackSnapshot(): PackSnapshot {
  return useSyncExternalStore(subscribePackState, getPackSnapshot);
}
