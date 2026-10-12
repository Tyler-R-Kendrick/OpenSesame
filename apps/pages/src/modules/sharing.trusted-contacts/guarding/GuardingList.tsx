/**
 * What the Guarding panel lists: the circles this device holds a part of, and
 * after them the invitations it agreed to that the owner has not answered yet.
 * With neither, one idle mark; a list that could not be read is a mark on the
 * panel and says nothing about being empty.
 */

import type { Agreement } from "@opensesame/app-core/lib/quorum/desk/index.js";
import type { HeldRecord } from "@opensesame/app-core/lib/quorum/records.js";
import { StatusMark } from "../../../components/StatusMark.js";
import { AgreementRow } from "./AgreementRow.js";
import { GuardingRow } from "./GuardingRow.js";

export function GuardingList({
  held,
  agreements,
  failure,
  forgetFailure,
  onAnswer,
  onLeave,
  onForget,
}: {
  held: readonly HeldRecord[];
  agreements: readonly Agreement[];
  /** The sentence for why the agreements could not be read; empty when they could. */
  failure: string;
  onAnswer: (circleId: string) => void;
  onLeave: (circleId: string) => void;
  /** Which agreement could not be forgotten, and the sentence for why. */
  forgetFailure: Readonly<{ inviteId: string | null; message: string }>;
  onForget: (agreement: Agreement) => Promise<boolean>;
}) {
  const nothing = held.length === 0 && agreements.length === 0;
  return (
    <>
      {failure || nothing ? (
        <div className="actions">
          {failure ? <StatusMark tone="err" label={failure} /> : null}
          {nothing && !failure ? (
            <StatusMark tone="idle" label="Nothing held for anyone yet." />
          ) : null}
        </div>
      ) : null}
      {nothing ? null : (
        <ul className="tc-rows">
          {held.map((one) => {
            const { circleId } = one.seat.signedPolicy.policy;
            return (
              <GuardingRow
                key={circleId}
                held={one}
                onAnswer={() => onAnswer(circleId)}
                onLeave={() => onLeave(circleId)}
              />
            );
          })}
          {agreements.map((one) => (
            <AgreementRow
              key={one.inviteId}
              agreement={one}
              failure={
                forgetFailure.inviteId === one.inviteId
                  ? forgetFailure.message
                  : ""
              }
              onForget={onForget}
            />
          ))}
        </ul>
      )}
    </>
  );
}
