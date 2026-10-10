/**
 * The invitation, and the people who answer it. The owner hands the
 * invitation to each contact over a road they already trust, the contact's
 * own device answers with an enrollment, and the owner adds it. Used when a
 * circle is made and again when more people are invited to one that exists.
 *
 * A contact is added only by the key beside the paste, never by the paste
 * arriving. Two contacts are independent unless the owner names a household
 * they share, so a quorum cannot quietly be one family's.
 */

import { randomBytes, toHex } from "@opensesame/app-core/lib/quorum/bytes.js";
import {
  acceptGuardian,
  dropDraftGuardian,
  readDraft,
} from "@opensesame/app-core/lib/quorum/desk/index.js";
import type { Packet } from "@opensesame/app-core/lib/quorum/packets.js";
import type { Guardian } from "@opensesame/app-core/lib/quorum/types.js";
import { useState } from "react";
import {
  type CeremonyFact,
  CeremonyShell,
} from "../../../components/CeremonyShell.js";
import { FieldShell } from "../../../components/FieldShell.js";
import { IconKey } from "../../../components/IconKey.js";
import { IconArrowRight, IconX } from "../../../components/Icons.js";
import { QrCode } from "../../../components/QrCode.js";
import { StatusMark } from "../../../components/StatusMark.js";
import { useCeremonyFailure } from "../failure-text.js";
import { PacketIn, PacketOut } from "../packet-field.js";
import type { Desk } from "../use-desk.js";
import { useLandOnIdAfter } from "./circle-focus.js";
import { custodyDomainOf } from "./circle-model.js";

export type PeopleNext = Readonly<{ label: string; onNext: () => void }>;

function describeEnrollment(packet: Packet): string | null {
  if (packet.kind !== "enrollment") return null;
  const keys = packet.value.credentials.length;
  return `${packet.value.name} · ${keys} key${keys === 1 ? "" : "s"}`;
}

function Person({
  person,
  busy,
  onRemove,
}: {
  person: Guardian;
  busy: boolean;
  onRemove: () => void;
}) {
  return (
    <li className="tcc-person">
      <span className="tcc-person__name">{person.name}</span>
      <StatusMark tone="ok" label={`${person.name} has answered`} />
      <IconKey
        small
        label={`Remove ${person.name}`}
        disabled={busy}
        onClick={onRemove}
      >
        <IconX size={16} />
      </IconKey>
    </li>
  );
}

/** The contacts who have answered: adding one from a paste, and letting one go. */
function useContacts(
  desk: Desk,
  circleId: string,
  onPeople: (next: readonly Guardian[]) => void,
) {
  const { ports } = desk;
  const [household, setHousehold] = useState("");
  const [busy, setBusy] = useState(false);
  const removal = useCeremonyFailure(
    "trusted-contacts:contact-remove",
    "Remove a contact",
  );

  async function reread(): Promise<void> {
    const draft = await readDraft(ports, circleId);
    onPeople(draft?.guardians ?? []);
  }

  async function add(text: string): Promise<void> {
    await acceptGuardian(ports, circleId, {
      packet: text,
      custodyDomain: custodyDomainOf(household, () => toHex(randomBytes(6))),
      contactRef: null,
    });
    await reread();
    setHousehold("");
  }

  async function remove(person: Guardian): Promise<void> {
    setBusy(true);
    await removal.run(async () => {
      await dropDraftGuardian(ports, circleId, person.id);
      await reread();
    });
    setBusy(false);
  }

  return { household, setHousehold, busy, removal, add, remove };
}

export function PeopleStep({
  desk,
  circleId,
  invite,
  people,
  onPeople,
  next,
  facts,
  name = "People",
}: {
  desk: Desk;
  circleId: string;
  /** The invitation, as the one line of text a contact is handed. */
  invite: string;
  /** The contacts who have answered so far. */
  people: readonly Guardian[];
  onPeople: (next: readonly Guardian[]) => void;
  /** The key that moves on, when this step is one of a run. */
  next?: PeopleNext;
  /** Which circle these people are for, so a round picked up again says so. */
  facts?: CeremonyFact[];
  name?: string;
}) {
  const contacts = useContacts(desk, circleId, onPeople);
  // A contact let go takes its key out of the page: the keyboard goes back to the field.
  useLandOnIdAfter(String(people.length), "tcc-enrollment");
  return (
    <CeremonyShell
      name={name}
      facts={facts}
      primary={
        next
          ? {
              label: next.label,
              icon: <IconArrowRight size={18} />,
              disabled: people.length === 0,
              onClick: next.onNext,
            }
          : undefined
      }
    >
      <PacketOut label="Invitation" copyLabel="invitation" packet={invite} />
      <QrCode value={invite} label="Invitation QR code" />
      <FieldShell
        id="tcc-household"
        label="Household"
        autoComplete="off"
        value={contacts.household}
        onValueChange={contacts.setHousehold}
      />
      <PacketIn
        id="tcc-enrollment"
        label="A contact's answer"
        kind="enrollment"
        commitLabel="Add this contact"
        describe={describeEnrollment}
        onPacket={contacts.add}
      />
      {people.length > 0 ? (
        <ul className="tcc-people" aria-label="Contacts">
          {people.map((person) => (
            <Person
              key={person.id}
              person={person}
              busy={contacts.busy}
              onRemove={() => void contacts.remove(person)}
            />
          ))}
        </ul>
      ) : null}
      {contacts.removal.message ? (
        <StatusMark tone="err" label={contacts.removal.message} />
      ) : null}
    </CeremonyShell>
  );
}
