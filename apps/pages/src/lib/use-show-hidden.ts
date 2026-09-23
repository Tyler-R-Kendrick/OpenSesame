import {
  showHiddenSnapshot,
  subscribeShowHidden,
} from "@opensesame/app-core/lib/show-hidden.js";
import { useSyncExternalStore } from "react";

/** Whether the rail lists hidden entries; re-renders when the choice flips. */
export function useShowHidden(): boolean {
  return useSyncExternalStore(
    subscribeShowHidden,
    showHiddenSnapshot,
    showHiddenSnapshot,
  );
}
