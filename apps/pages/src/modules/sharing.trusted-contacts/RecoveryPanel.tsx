/**
 * Settings › Trusted contacts › Recovery (ADR 0186): the recoveries this
 * vault's owner has started from a circle's recovery file, with how many
 * contacts have approved each and how many have released their share.
 */

import type { RecoveryView } from "@opensesame/app-core/lib/quorum/desk/index.js";
import { StatusMark } from "../../components/StatusMark.js";
import { PanelFrame, Row, useSaid } from "./panel-frame.js";
import { countText, recoveryFacts, recoveryMark } from "./row-model.js";
import { type Desk, useDesk } from "./use-desk.js";
import { useRecoveries } from "./use-recoveries.js";

function Rows({ views }: { views: readonly RecoveryView[] }) {
  return (
    <ul className="tc-rows">
      {views.map((view) => {
        const mark = recoveryMark(view.status);
        return (
          <Row
            key={view.requestId}
            name={view.label}
            facts={recoveryFacts(view.approvedBy, view.releasedBy)}
            marks={<StatusMark tone={mark.tone} label={mark.label} />}
          />
        );
      })}
    </ul>
  );
}

function Body({
  views,
  failure,
}: { views: readonly RecoveryView[] | null; failure: string }) {
  if (failure) {
    return (
      <div className="actions">
        <StatusMark tone="err" label={failure} />
      </div>
    );
  }
  if (views === null) return null;
  if (views.length === 0) {
    return (
      <div className="actions">
        <StatusMark tone="idle" label="No recoveries in progress." />
      </div>
    );
  }
  return <Rows views={views} />;
}

function Recoveries({ desk }: { desk: Desk }) {
  const { views, failure } = useRecoveries(desk);
  const said = useSaid(
    views === null ? "" : countText(views.length, "recovery", "recoveries"),
  );
  return (
    <PanelFrame
      id="recovery"
      title="Recovery"
      target="settings.trusted-contacts-recovery"
      said={said}
    >
      <Body views={views} failure={failure} />
    </PanelFrame>
  );
}

export function RecoveryPanel() {
  const desk = useDesk();
  return desk ? <Recoveries desk={desk} /> : null;
}
