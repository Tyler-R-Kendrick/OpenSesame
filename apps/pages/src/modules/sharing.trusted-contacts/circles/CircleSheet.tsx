/**
 * A circle the owner keeps (ADR 0186 §10): its contacts and whether each has
 * taken their part, its rule and epoch, anything worth a second look, and the
 * requests waiting on it. The ceremonies that act on it open from here:
 * invite more people, change it, ask its contacts to approve a share, cancel
 * a request, and retire it.
 *
 * Retiring forgets the circle's owner key: the contacts keep what they hold,
 * and nothing can change it again. It takes two presses, the first of which
 * only changes what the key says.
 */

import {
  type AskView,
  type CustodyStatus,
  retireCircle,
} from "@opensesame/app-core/lib/quorum/desk/index.js";
import { policyWarnings } from "@opensesame/app-core/lib/quorum/policy.js";
import { ruleText } from "@opensesame/app-core/lib/quorum/records.js";
import type {
  CirclePolicy,
  Guardian,
} from "@opensesame/app-core/lib/quorum/types.js";
import { type RefObject, useRef, useState } from "react";
import { CeremonySheet } from "../../../components/CeremonySheet.js";
import { CeremonyShell } from "../../../components/CeremonyShell.js";
import { IconKey } from "../../../components/IconKey.js";
import {
  IconChevronRight,
  IconEdit,
  IconLayers,
  IconMail,
  IconPlus,
  IconShare,
  IconX,
} from "../../../components/Icons.js";
import { StatusMark } from "../../../components/StatusMark.js";
import { useCeremonyFailure } from "../failure-text.js";
import { circleMark } from "../row-model.js";
import type { Desk } from "../use-desk.js";
import { askFact, askMark, askName } from "./ask-model.js";
import "./circles.css";
import { useCircleView } from "./use-circle-view.js";

export type Sub = "packets" | "invite" | "change" | "ask" | "cancel";

const KEYS: readonly Readonly<{ sub: Sub; label: string }>[] = [
  { sub: "packets", label: "Hand out the packets" },
  { sub: "invite", label: "Invite more people" },
  { sub: "change", label: "Change the circle" },
  { sub: "ask", label: "Ask contacts to approve a share" },
  { sub: "cancel", label: "Cancel a request" },
];

function Glyph({ sub }: { sub: Sub }) {
  switch (sub) {
    case "packets":
      return <IconMail size={15} />;
    case "invite":
      return <IconPlus size={15} />;
    case "change":
      return <IconEdit size={15} />;
    case "ask":
      return <IconShare size={15} />;
    case "cancel":
      return <IconX size={15} />;
  }
}

function Commands({
  returnTo,
  back,
  packets,
  onOpen,
}: {
  returnTo: Sub | undefined;
  back: RefObject<HTMLButtonElement | null>;
  /** Something was dealt and is still to be handed out. */
  packets: boolean;
  onOpen: (sub: Sub) => void;
}) {
  return (
    <fieldset className="vtree__keys" aria-label="Circle commands">
      {KEYS.filter(({ sub }) => packets || sub !== "packets").map(
        ({ sub, label }) => (
          <IconKey
            key={sub}
            id={`tcc-circle-${sub}`}
            keyRef={returnTo === sub ? back : undefined}
            small
            label={label}
            onClick={() => onOpen(sub)}
          >
            <Glyph sub={sub} />
          </IconKey>
        ),
      )}
    </fieldset>
  );
}

function Contacts({
  policy,
  custody,
  newcomers,
}: {
  policy: CirclePolicy;
  custody: CustodyStatus | null;
  newcomers: readonly Guardian[];
}) {
  const recovers = policy.operations.includes("recover-collection");
  return (
    <ul className="tcc-people" aria-label="Contacts">
      {policy.guardians.map((person) => {
        const holds = custody?.held.includes(person.id) ?? false;
        return (
          <li key={person.id} className="tcc-person">
            <span className="tcc-person__name">{person.name}</span>
            {recovers && custody ? (
              <StatusMark
                tone={holds ? "ok" : "idle"}
                label={
                  holds
                    ? `${person.name} holds a share`
                    : `Waiting for ${person.name}'s receipt`
                }
              />
            ) : null}
          </li>
        );
      })}
      {newcomers.map((person) => (
        <li key={person.id} className="tcc-person">
          <span className="tcc-person__name">{person.name}</span>
          <StatusMark
            tone="idle"
            label={`${person.name} joins when the circle is changed`}
          />
        </li>
      ))}
    </ul>
  );
}

function Requests({
  asks,
  contacts,
  onOpen,
}: {
  asks: readonly AskView[];
  contacts: number;
  onOpen: (digest: string) => void;
}) {
  if (asks.length === 0) return null;
  return (
    <ul className="tcc-people" aria-label="Requests">
      {asks.map((ask) => {
        const mark = askMark(ask.status);
        return (
          <li key={ask.digest} className="tcc-person">
            <span className="tcc-person__name">
              {askName(ask)}
              <span className="tc-fact">{askFact(ask, contacts)}</span>
            </span>
            <StatusMark tone={mark.tone} label={mark.label} />
            <IconKey
              small
              label={`Open the request for ${ask.request.grant?.resourceLabel ?? "this share"}`}
              onClick={() => onOpen(ask.digest)}
            >
              <IconChevronRight size={16} />
            </IconKey>
          </li>
        );
      })}
    </ul>
  );
}

/** The two-press retire: the first press changes what the key says, the second forgets the circle. */
function useRetire(desk: Desk, circleId: string, onRetired: () => void) {
  const [armed, setArmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const failure = useCeremonyFailure(
    "trusted-contacts:circle-retire",
    "Retire this circle",
  );
  async function press(): Promise<void> {
    if (!armed) {
      setArmed(true);
      return;
    }
    if (busy) return;
    setBusy(true);
    const done = await failure.run(async () => {
      await retireCircle(desk.ports, circleId);
      await desk.refresh();
    });
    setBusy(false);
    if (done.ok) onRetired();
    else setArmed(false);
  }
  return { armed, busy, failure, press };
}

export function CircleSheet({
  desk,
  circleId,
  returnTo,
  onOpen,
  onClose,
  onRetired,
}: {
  desk: Desk;
  circleId: string;
  /** The ceremony the person has just come back from: where the keyboard lands. */
  returnTo?: Sub;
  /** Open a ceremony on this circle, or a request already made. */
  onOpen: (sub: Sub, digest?: string) => void;
  onClose: () => void;
  /** The circle is gone: the panel it was listed in is where the keyboard goes. */
  onRetired: () => void;
}) {
  const record = desk.owned.find(
    (r) => r.signedPolicy.policy.circleId === circleId,
  );
  const view = useCircleView(desk, circleId);
  const back = useRef<HTMLButtonElement>(null);
  const retire = useRetire(desk, circleId, onRetired);
  if (!record) return null;
  const { policy } = record.signedPolicy;
  const mark = circleMark(record.state);

  return (
    <CeremonySheet
      title={policy.label}
      mark={<IconLayers size={20} />}
      onClose={onClose}
      initialFocus={returnTo && returnTo !== "packets" ? back : undefined}
    >
      <CeremonyShell
        name={ruleText(policy)}
        facts={[
          { key: "Epoch", value: String(policy.epoch) },
          { key: "Protects", value: policy.collection },
        ]}
        primary={{
          label: retire.armed
            ? "Retire this circle for good"
            : "Retire this circle",
          tone: "danger",
          busy: retire.busy,
          onClick: () => void retire.press(),
        }}
      >
        <Commands
          returnTo={returnTo}
          back={back}
          packets={view.dealt !== null}
          onOpen={onOpen}
        />
        <span className="tc-row__marks">
          <StatusMark tone={mark.tone} label={mark.label} />
          {policyWarnings(policy).map((warning) => (
            <StatusMark
              key={`${warning.code}:${warning.message}`}
              tone="warn"
              label={warning.message}
            />
          ))}
          {retire.failure.message ? (
            <StatusMark tone="err" label={retire.failure.message} />
          ) : null}
        </span>
        <Contacts
          policy={policy}
          custody={view.custody}
          newcomers={view.newcomers}
        />
        <Requests
          asks={view.asks}
          contacts={policy.guardians.length}
          onOpen={(digest) => onOpen("ask", digest)}
        />
      </CeremonyShell>
    </CeremonySheet>
  );
}
