/**
 * What the Recovery panel does between its sheets (ADR 0186 §10): which sheet
 * is open, what each one leaves behind, and where the keyboard goes when it
 * closes. The panel draws; this decides.
 */

import type { RecoveryView } from "@opensesame/app-core/lib/quorum/desk/index.js";
import { useState } from "react";
import { byId, useFocusAfter } from "../../../lib/use-focus-after.js";
import { downloadFile } from "../packet-field.js";
import { useSaid } from "../panel-frame.js";
import type { Desk } from "../use-desk.js";
import { useRecoveries } from "../use-recoveries.js";
import { saveKeyId } from "./RecoveryRows.js";
import { panelSaid, recoveredFileName } from "./recovery-model.js";
import { useArrival } from "./use-arrival.js";
import { type Recovered, useRecovered } from "./use-recovered.js";

export type Sheet =
  | Readonly<{ kind: "start" }>
  | Readonly<{ kind: "recovery"; view: RecoveryView }>
  | Readonly<{ kind: "import"; requestId: string }>;

export function useRecoveryPanel(desk: Desk) {
  const { views, failure, refresh } = useRecoveries(desk);
  const recovered = useRecovered(desk.ports, refresh);
  const [sheet, setSheet] = useState<Sheet | null>(null);
  // A sheet that ends in a row that was not there leaves the keyboard on the
  // new row's key; one that takes its row away leaves it on the head's.
  const arrive = useArrival();
  const land = useFocusAfter(false);
  const waiting =
    views?.filter(
      (view) => !recovered.held.some((one) => one.requestId === view.requestId),
    ).length ?? 0;
  const said = useSaid(
    views === null ? "" : panelSaid(waiting, recovered.held.length),
  );
  const importing = recovered.held.find(
    (item) => sheet?.kind === "import" && item.requestId === sheet.requestId,
  );
  return {
    views,
    failure,
    refresh,
    recovered,
    sheet,
    setSheet,
    said,
    importing,
    close: () => {
      setSheet(null);
      void refresh();
    },
    started: async (view: RecoveryView) => {
      await refresh();
      setSheet({ kind: "recovery", view });
    },
    opened: async (item: Omit<Recovered, "safe">) => {
      recovered.keep(item);
      setSheet(null);
      arrive(saveKeyId(item.requestId));
    },
    gaveUp: async () => {
      await refresh();
      setSheet(null);
      land(byId("recovery-start"));
    },
    save: (item: Recovered) => {
      downloadFile(recoveredFileName(item.label), item.text);
      void recovered.secure(item.requestId, "file");
    },
  };
}

export type RecoveryPanelState = ReturnType<typeof useRecoveryPanel>;
