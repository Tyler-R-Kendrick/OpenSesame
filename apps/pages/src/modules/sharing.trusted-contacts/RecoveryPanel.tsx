/**
 * Settings › Trusted contacts › Recovery (ADR 0187): the recoveries this
 * vault's owner has started from a circle's recovery file, with how many
 * contacts have approved each and how many have released their share, and
 * what a finished one handed back.
 *
 * The head's one key starts a recovery. A row's key opens that recovery's
 * sheet, where the request goes out and the answers come back. When enough
 * shares are in, opening it hands back what it protected as a row with the
 * two ways out. The recovery is not over until one of them has been taken: a
 * reload finds it again, complete, and it can be opened once more.
 */

import type { RecoveryView } from "@opensesame/app-core/lib/quorum/desk/index.js";
import { IconKey } from "../../components/IconKey.js";
import { IconPlus } from "../../components/Icons.js";
import { StatusMark } from "../../components/StatusMark.js";
import { useGuideTarget } from "../../tutorial/registry/react.jsx";
import { PanelFrame } from "./panel-frame.js";
import { RecoveredRow, RecoveryRow } from "./recovery/RecoveryRows.js";
import { Sheets } from "./recovery/RecoverySheets.js";
import type { Recovered } from "./recovery/use-recovered.js";
import { useRecoveryPanel } from "./recovery/use-recovery-panel.js";
import { type Desk, useDesk } from "./use-desk.js";
import "./recovery/recovery.css";

function Body({
  views,
  failure,
  recovered,
  failureOf,
  onOpen,
  onSave,
  onImport,
}: {
  views: readonly RecoveryView[] | null;
  failure: string;
  recovered: readonly Recovered[];
  failureOf: (requestId: string) => string;
  onOpen: (view: RecoveryView) => void;
  onSave: (item: Recovered) => void;
  onImport: (item: Recovered) => void;
}) {
  if (failure) {
    return (
      <div className="actions">
        <StatusMark tone="err" label={failure} />
      </div>
    );
  }
  if (views === null) return null;
  // A recovery that has handed its items back is shown as those items, once.
  const open = views.filter(
    (view) => !recovered.some((item) => item.requestId === view.requestId),
  );
  if (open.length === 0 && recovered.length === 0) {
    return (
      <div className="actions">
        <StatusMark tone="idle" label="No recoveries in progress." />
      </div>
    );
  }
  return (
    <ul className="tc-rows">
      {recovered.map((item) => (
        <RecoveredRow
          key={item.requestId}
          item={item}
          failure={failureOf(item.requestId)}
          onSave={() => onSave(item)}
          onImport={() => onImport(item)}
        />
      ))}
      {open.map((view) => (
        <RecoveryRow
          key={view.requestId}
          view={view}
          onOpen={() => onOpen(view)}
        />
      ))}
    </ul>
  );
}

function Recoveries({ desk }: { desk: Desk }) {
  const panel = useRecoveryPanel(desk);
  const startKey = useGuideTarget<HTMLButtonElement>("recovery.start");
  return (
    <PanelFrame
      id="recovery"
      title="Recovery"
      target="settings.trusted-contacts-recovery"
      said={panel.said}
      keys={
        <IconKey
          id="recovery-start"
          keyRef={startKey}
          label="Start a recovery"
          small
          onClick={() => panel.setSheet({ kind: "start" })}
        >
          <IconPlus size={15} />
        </IconKey>
      }
      overlay={<Sheets desk={desk} panel={panel} />}
    >
      <Body
        views={panel.views}
        failure={panel.failure}
        recovered={panel.recovered.held}
        failureOf={panel.recovered.failure}
        onOpen={(view) => panel.setSheet({ kind: "recovery", view })}
        onSave={panel.save}
        onImport={(item) =>
          panel.setSheet({ kind: "import", requestId: item.requestId })
        }
      />
    </PanelFrame>
  );
}

export function RecoveryPanel() {
  const desk = useDesk();
  return desk ? <Recoveries desk={desk} /> : null;
}
