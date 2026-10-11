/**
 * One circle this device guards: its name, whose it is (by the owner key's
 * short name, the one thing two people can check by voice), whether this device
 * holds a share or only a seat, and where it stands. Its two keys answer a
 * request on that circle and leave it.
 */

import type { HeldRecord } from "@opensesame/app-core/lib/quorum/records.js";
import { IconKey } from "../../../components/IconKey.js";
import { IconSearch, IconSignOut } from "../../../components/Icons.js";
import { StatusMark } from "../../../components/StatusMark.js";
import { heldFacts, heldMark } from "../row-model.js";

export function GuardingRow({
  held,
  onAnswer,
  onLeave,
}: {
  held: HeldRecord;
  onAnswer: () => void;
  onLeave: () => void;
}) {
  const { policy } = held.seat.signedPolicy;
  const state = heldMark(held.state);
  const holdsShare = held.holding !== null;
  return (
    <li className="tc-row">
      <h3>{policy.label}</h3>
      <span className="tc-row__facts">{heldFacts(policy, holdsShare)}</span>
      <span className="tc-row__marks">
        <StatusMark
          tone={holdsShare ? "ok" : "idle"}
          label={holdsShare ? "Holds a share" : "Seat only"}
        />
        <StatusMark tone={state.tone} label={state.label} />
      </span>
      <span className="tc-row__keys">
        <IconKey
          id={`guarding-answer-${policy.circleId}`}
          label={`Answer a request for ${policy.label}`}
          small
          onClick={onAnswer}
        >
          <IconSearch size={15} />
        </IconKey>
        <IconKey
          id={`guarding-leave-${policy.circleId}`}
          label={`Leave ${policy.label}`}
          small
          onClick={onLeave}
        >
          <IconSignOut size={15} />
        </IconKey>
      </span>
    </li>
  );
}
