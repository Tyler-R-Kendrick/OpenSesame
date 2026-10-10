/**
 * Settings › Trusted contacts › Circles (ADR 0186): the circles this vault's
 * owner keeps, each with its rule, how many contacts it has and where it
 * stands. The ceremonies that make and change one hang from this panel.
 */

import { StatusMark } from "../../components/StatusMark.js";
import { PanelFrame, Row, useSaid } from "./panel-frame.js";
import { circleFacts, circleMark, countText } from "./row-model.js";
import { type Desk, useDesk } from "./use-desk.js";

function Circles({ desk }: { desk: Desk }) {
  const said = useSaid(countText(desk.owned.length, "circle"));
  return (
    <PanelFrame
      id="circles"
      title="Circles"
      target="settings.trusted-contacts-circles"
      said={said}
    >
      {desk.owned.length === 0 ? (
        <div className="actions">
          <StatusMark tone="idle" label="No circles yet." />
        </div>
      ) : (
        <ul className="tc-rows">
          {desk.owned.map(({ signedPolicy, state }) => {
            const mark = circleMark(state);
            return (
              <Row
                key={signedPolicy.policy.circleId}
                name={signedPolicy.policy.label}
                facts={circleFacts(signedPolicy.policy)}
                marks={<StatusMark tone={mark.tone} label={mark.label} />}
              />
            );
          })}
        </ul>
      )}
    </PanelFrame>
  );
}

export function CirclesPanel() {
  const desk = useDesk();
  return desk ? <Circles desk={desk} /> : null;
}
