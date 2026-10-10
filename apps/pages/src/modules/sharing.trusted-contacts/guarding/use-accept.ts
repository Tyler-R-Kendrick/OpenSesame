/**
 * Agreeing to guard a circle, one step at a time: read the invitation, then
 * agree with a name and one security key or two. The desk does the work; this
 * only keeps what a screen needs between steps.
 *
 * What is kept is public: the invitation (it holds the owner's public key),
 * and the answer to hand back. The receiving key the desk makes stays in its
 * sealed pending store and never reaches this hook.
 */

import {
  type Accepted,
  type InviteView,
  acceptInvitation,
  readInvitation,
} from "@opensesame/app-core/lib/quorum/desk/index.js";
import { useState } from "react";
import { type CeremonyFailure, useCeremonyFailure } from "../failure-text.js";
import type { Desk } from "../use-desk.js";
import { NAME_MAX } from "./guarding-model.js";

export type Reading = Readonly<{ packet: string; view: InviteView }>;

/** The labels the owner will see against each key of this guardian. */
export function keyLabels(backup: boolean): readonly string[] {
  return backup ? ["Security key", "Backup key"] : ["Security key"];
}

export type AcceptFlow = Readonly<{
  reading: Reading | null;
  answer: Accepted | null;
  name: string;
  setName: (next: string) => void;
  backup: boolean;
  setBackup: (next: boolean) => void;
  busy: boolean;
  ready: boolean;
  failure: CeremonyFailure;
  read: (packet: string) => Promise<void>;
  agree: () => Promise<void>;
}>;

export function useAccept(desk: Desk, onAgreed: () => void): AcceptFlow {
  const [reading, setReading] = useState<Reading | null>(null);
  const [answer, setAnswer] = useState<Accepted | null>(null);
  const [name, setNameText] = useState("");
  const [backup, setBackup] = useState(false);
  const [busy, setBusy] = useState(false);
  const failure = useCeremonyFailure(
    "trusted-contacts:guarding-agree",
    "Accept an invitation",
  );
  const ready = reading?.view.originOk === true && name.trim() !== "" && !busy;

  async function read(packet: string): Promise<void> {
    setReading({ packet, view: readInvitation(desk.ports, packet) });
  }

  async function agree(): Promise<void> {
    if (!reading || !ready) return;
    setBusy(true);
    const done = await failure.run(() =>
      acceptInvitation(desk.ports, {
        packet: reading.packet,
        name: name.trim(),
        keyLabels: keyLabels(backup),
      }),
    );
    setBusy(false);
    if (done.ok) {
      setAnswer(done.value);
      onAgreed();
    }
  }

  return {
    reading,
    answer,
    name,
    setName: (next) => {
      setNameText(next.slice(0, NAME_MAX));
      failure.clear();
    },
    backup,
    setBackup: (next) => {
      setBackup(next);
      failure.clear();
    },
    busy,
    ready,
    failure,
    read,
    agree,
  };
}
