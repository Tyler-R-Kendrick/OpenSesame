/**
 * Settings › Trusted contacts › Guarding (ADR 0186): the circles other people
 * asked this vault's owner to take a part in, each a share of a recovery key
 * or only a seat at the approvals, with whose it is and where it stands.
 */

import { StatusMark } from "../../components/StatusMark.js";
import { PanelFrame, Row, useSaid } from "./panel-frame.js";
import { countText, heldFacts, heldMark } from "./row-model.js";
import { type Desk, useDesk } from "./use-desk.js";

function Guarding({ desk }: { desk: Desk }) {
  const said = useSaid(`${countText(desk.held.length, "circle")} held`);
  return (
    <PanelFrame
      id="guarding"
      title="Guarding"
      target="settings.trusted-contacts-guarding"
      said={said}
    >
      {desk.held.length === 0 ? (
        <div className="actions">
          <StatusMark tone="idle" label="Nothing held for anyone yet." />
        </div>
      ) : (
        <ul className="tc-rows">
          {desk.held.map(({ seat, holding, state }) => {
            const { policy } = seat.signedPolicy;
            const mark = heldMark(state);
            return (
              <Row
                key={policy.circleId}
                name={policy.label}
                facts={heldFacts(policy, holding !== null)}
                marks={<StatusMark tone={mark.tone} label={mark.label} />}
              />
            );
          })}
        </ul>
      )}
    </PanelFrame>
  );
}

export function GuardingPanel() {
  const desk = useDesk();
  return desk ? <Guarding desk={desk} /> : null;
}
