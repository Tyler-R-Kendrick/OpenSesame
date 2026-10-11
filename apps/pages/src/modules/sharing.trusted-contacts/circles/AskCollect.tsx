/**
 * The second half: the request, to hand to the contacts, and their approvals
 * coming back. A contact's approval is counted by the ledger, which checks it
 * against the policy and the request it was made for. When enough have
 * approved and the delay has passed, one key writes the share, once.
 */

import {
  type AskView,
  applyAsk,
  askStatus,
  collectApprovals,
} from "@opensesame/app-core/lib/quorum/desk/index.js";
import { DeskError } from "@opensesame/app-core/lib/quorum/desk/index.js";
import { useState } from "react";
import { CeremonyShell } from "../../../components/CeremonyShell.js";
import { ReloadKey } from "../../../components/IconKey.js";
import { IconShare } from "../../../components/Icons.js";
import { StatusMark } from "../../../components/StatusMark.js";
import { useCeremonyFailure } from "../failure-text.js";
import { PacketIn, PacketOut } from "../packet-field.js";
import type { Desk } from "../use-desk.js";
import { askFact, askMark, askName } from "./ask-model.js";

export function AskCollect({
  desk,
  view,
  onView,
  contacts,
}: {
  desk: Desk;
  view: AskView;
  onView: (next: AskView) => void;
  /** How many contacts the circle has. */
  contacts: number;
}) {
  const { ports } = desk;
  const [busy, setBusy] = useState(false);
  const share = useCeremonyFailure("trusted-contacts:ask-share", "Share it");
  const refused = useCeremonyFailure(
    "trusted-contacts:ask-refused",
    "Approvals",
  );
  const reload = useCeremonyFailure("trusted-contacts:ask-reload", "Request");
  const mark = askMark(view.status);

  async function collect(text: string): Promise<void> {
    refused.clear();
    const { outcomes, view: next } = await collectApprovals(
      ports,
      view.digest,
      text,
    );
    onView(next);
    const no = outcomes.find((outcome) => !outcome.ok);
    if (!no || no.ok) return;
    const error = new DeskError(no.code, no.message);
    if (outcomes.every((outcome) => !outcome.ok)) throw error;
    // Some were counted and the paste is done with; the one that was not is told.
    void refused.run(() => Promise.reject(error));
  }

  async function recheck(): Promise<void> {
    const done = await reload.run(() => askStatus(ports, view.digest));
    if (done.ok) onView(done.value);
  }

  async function carryOut(): Promise<void> {
    if (busy) return;
    setBusy(true);
    const done = await share.run(async () => {
      await applyAsk(ports, view.digest);
      return askStatus(ports, view.digest);
    });
    setBusy(false);
    if (done.ok) onView(done.value);
  }

  return (
    <CeremonyShell
      name={askName(view)}
      top={askFact(view, contacts)}
      primary={
        view.status.state === "authorized"
          ? {
              label: "Share it",
              icon: <IconShare size={18} />,
              busy,
              onClick: () => void carryOut(),
            }
          : undefined
      }
    >
      <PacketOut label="Request" copyLabel="request" packet={view.packet} />
      <span className="tc-row__marks">
        <StatusMark tone={mark.tone} label={mark.label} />
        <ReloadKey
          label="Check this request again"
          onReload={() => void recheck()}
        />
        {share.message ? <StatusMark tone="err" label={share.message} /> : null}
        {refused.message ? (
          <StatusMark tone="err" label={refused.message} />
        ) : null}
        {reload.message ? (
          <StatusMark tone="err" label={reload.message} />
        ) : null}
      </span>
      {view.status.state === "executed" ? null : (
        <PacketIn
          id="tcc-approvals"
          label="Approvals"
          kind={["approval", "approvals"]}
          commitLabel="Add approvals"
          onPacket={collect}
        />
      )}
    </CeremonyShell>
  );
}
