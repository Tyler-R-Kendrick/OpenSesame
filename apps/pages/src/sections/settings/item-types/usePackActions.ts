/**
 * What pressing a row does (ADR 0165): switch the pack on — the cue to
 * download and install — or off, and tell assistive technology what moved.
 * The work itself is `lib/type-packs/installer.ts`, queued and paced off the
 * main thread; this only starts it and listens.
 */

import {
  disablePack,
  enablePack,
} from "@opensesame/app-core/lib/type-packs/installer.js";
import {
  type PackPhase,
  type PackSnapshot,
  statusOf,
} from "@opensesame/app-core/lib/type-packs/state.js";
import {
  type PackRow,
  transitionSentence,
} from "@opensesame/app-core/sections/settings/item-type-packs-model.js";
import { packEntries } from "@opensesame/vault-item-types";
import { useEffect, useRef, useState } from "react";

export type PackOutcome = { tone: "ok" | "err"; text: string } | null;

/** A change worth saying aloud, from one snapshot to the next. */
function announcement(
  before: ReadonlyMap<string, PackPhase>,
  snapshot: PackSnapshot,
): string | null {
  for (const entry of packEntries()) {
    const status = statusOf(entry.id, snapshot);
    const said = transitionSentence(
      entry.title,
      before.get(entry.id) ?? "off",
      status.phase,
      status.reason ?? null,
    );
    if (said !== null) return said;
  }
  return null;
}

export function usePackActions(snapshot: PackSnapshot) {
  const [outcome, setOutcome] = useState<PackOutcome>(null);
  const [said, setSaid] = useState("");
  const seen = useRef(new Map<string, PackPhase>());

  useEffect(() => {
    const next = announcement(seen.current, snapshot);
    seen.current = new Map(
      packEntries().map((entry) => [
        entry.id,
        statusOf(entry.id, snapshot).phase,
      ]),
    );
    if (next !== null) setSaid(next);
  }, [snapshot]);

  const toggle = (row: PackRow) => {
    setOutcome(null);
    if (!row.checked) {
      enablePack(row.id);
      return;
    }
    void disablePack(row.id).then((result) => {
      if (!result.ok) setOutcome({ tone: "err", text: result.reason });
    });
  };

  return { toggle, outcome, said };
}
