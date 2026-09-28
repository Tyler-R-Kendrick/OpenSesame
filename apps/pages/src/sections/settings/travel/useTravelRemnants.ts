/**
 * The leftovers a cut-short departure left on this device (ADR 0143), read
 * again whenever the panel's state moves — after a departure, a return, or
 * a clear.
 */

import {
  type TravelRemnant,
  travelRemnants,
} from "@opensesame/app-core/lib/travel/index.js";
import { useCallback, useEffect, useState } from "react";
import type { TravelNotice } from "./TravelViews.js";

export function useTravelRemnants(owner: boolean, moved: TravelNotice | null) {
  const [remnants, setRemnants] = useState<readonly TravelRemnant[]>([]);
  const [reads, setReads] = useState(0);
  // biome-ignore lint/correctness/useExhaustiveDependencies: `moved` and `reads` are re-read triggers, not inputs.
  useEffect(() => {
    if (!owner) {
      setRemnants([]);
      return;
    }
    let live = true;
    travelRemnants()
      .then((found) => {
        if (live) setRemnants(found);
      })
      .catch(() => {
        if (live) setRemnants([]);
      });
    return () => {
      live = false;
    };
  }, [owner, moved, reads]);
  const reread = useCallback(() => setReads((n) => n + 1), []);
  return { remnants, reread };
}
