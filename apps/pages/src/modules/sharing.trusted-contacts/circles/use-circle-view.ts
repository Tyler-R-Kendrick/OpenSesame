/**
 * What the circle sheet shows beyond the circle's own record: who has taken
 * their part, the requests waiting on the contacts, the people invited since
 * the circle was last changed, and the packets still to be handed out. Read when the sheet opens and again when
 * the record changes under it.
 */

import {
  type AskView,
  type CustodyStatus,
  type Dealt,
  custodyStatus,
  pendingAsks,
  readDealt,
  readDraft,
} from "@opensesame/app-core/lib/quorum/desk/index.js";
import type { Guardian } from "@opensesame/app-core/lib/quorum/types.js";
import { useEffect, useState } from "react";
import type { Desk } from "../use-desk.js";

export type CircleView = Readonly<{
  custody: CustodyStatus | null;
  asks: readonly AskView[];
  newcomers: readonly Guardian[];
  /** What was dealt and is still to be handed out, when anything is. */
  dealt: Dealt | null;
}>;

const NOTHING: CircleView = {
  custody: null,
  asks: [],
  newcomers: [],
  dealt: null,
};

export function useCircleView(desk: Desk, circleId: string): CircleView {
  const { ports } = desk;
  const [view, setView] = useState<CircleView>(NOTHING);
  // biome-ignore lint/correctness/useExhaustiveDependencies: read again when the circle's record changes under the sheet
  useEffect(() => {
    let live = true;
    // One lookup at a time can fail without taking the others with it.
    Promise.all([
      custodyStatus(ports, circleId).catch(() => null),
      pendingAsks(ports, circleId).catch(() => []),
      readDraft(ports, circleId).catch(() => null),
      readDealt(ports, circleId).catch(() => null),
    ]).then(([custody, asks, draft, dealt]) => {
      if (live) {
        setView({ custody, asks, newcomers: draft?.guardians ?? [], dealt });
      }
    });
    return () => {
      live = false;
    };
  }, [ports, circleId, desk.owned]);
  return view;
}
