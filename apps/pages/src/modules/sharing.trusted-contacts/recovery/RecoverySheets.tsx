/**
 * The sheets the Recovery panel opens, one at a time (ADR 0186 §10): start a
 * recovery, work one, and put what it handed back in this vault.
 */

import type { Desk } from "../use-desk.js";
import { ImportRecovered } from "./ImportRecovered.js";
import { RecoverySheet } from "./RecoverySheet.js";
import { StartSheet } from "./StartSheet.js";
import type { RecoveryPanelState } from "./use-recovery-panel.js";

export function Sheets({
  desk,
  panel,
}: {
  desk: Desk;
  panel: RecoveryPanelState;
}) {
  const { sheet, importing, recovered } = panel;
  return (
    <>
      {sheet?.kind === "start" ? (
        <StartSheet
          desk={desk}
          onStarted={panel.started}
          onClose={panel.close}
        />
      ) : null}
      {sheet?.kind === "recovery" ? (
        <RecoverySheet
          key={sheet.view.requestId}
          desk={desk}
          initial={sheet.view}
          onChanged={panel.refresh}
          onOpened={panel.opened}
          onGaveUp={panel.gaveUp}
          onClose={panel.close}
        />
      ) : null}
      {importing ? (
        <ImportRecovered
          item={importing}
          onClose={() => panel.setSheet(null)}
          onImported={() => void recovered.secure(importing.requestId, "vault")}
        />
      ) : null}
    </>
  );
}
