import type { VaultHeader } from "@opensesame/vault-core";
import { WrongPasswordError } from "@opensesame/vault-core";
import type { FormEvent } from "react";
import {
  mintCliAuthorizePasskeyProof,
  mintCliAuthorizePinProof,
} from "./cli-authorize-mint-proof.js";
import type { CliAuthorizeRow } from "./cli-authorize-session.js";

type NoteFailure = (title: string, message: string) => void;

async function approveWithProof(
  humanProof: string,
  onRespond: (
    decision: "approve" | "deny",
    humanProof?: string,
  ) => Promise<boolean>,
  onDone: () => void,
  noteFailure: NoteFailure,
  clearMark: () => void,
  setMark: (message: string) => void,
) {
  clearMark();
  const ok = await onRespond("approve", humanProof);
  if (!ok) {
    noteFailure("CLI authorization failed", "That did not work.");
    setMark("That did not work.");
    return;
  }
  onDone();
}

export async function runCliAuthorizePasskeyProof(input: {
  row: CliAuthorizeRow;
  busy: boolean;
  onBusyChange: (busy: boolean) => void;
  onRespond: (
    decision: "approve" | "deny",
    humanProof?: string,
  ) => Promise<boolean>;
  onDone: () => void;
  noteFailure: NoteFailure;
  clearMark: () => void;
  setMark: (message: string) => void;
}): Promise<void> {
  if (input.busy) return;
  input.onBusyChange(true);
  input.clearMark();
  try {
    const proof = await mintCliAuthorizePasskeyProof(input.row);
    input.onBusyChange(false);
    await approveWithProof(
      proof,
      input.onRespond,
      input.onDone,
      input.noteFailure,
      input.clearMark,
      input.setMark,
    );
  } catch (error) {
    input.onBusyChange(false);
    const message =
      error instanceof WrongPasswordError
        ? error.message
        : "Passkey confirmation was cancelled.";
    input.noteFailure("Passkey confirmation", message);
    input.setMark(message);
  }
}

export async function runCliAuthorizePinProof(input: {
  row: CliAuthorizeRow;
  pin: string;
  header: VaultHeader;
  busy: boolean;
  onBusyChange: (busy: boolean) => void;
  onRespond: (
    decision: "approve" | "deny",
    humanProof?: string,
  ) => Promise<boolean>;
  onDone: () => void;
  noteFailure: NoteFailure;
  clearMark: () => void;
  setMark: (message: string) => void;
  event: FormEvent;
}): Promise<void> {
  input.event.preventDefault();
  if (input.busy) return;
  input.onBusyChange(true);
  input.clearMark();
  try {
    const proof = await mintCliAuthorizePinProof(
      input.row,
      input.pin,
      input.header,
    );
    input.onBusyChange(false);
    await approveWithProof(
      proof,
      input.onRespond,
      input.onDone,
      input.noteFailure,
      input.clearMark,
      input.setMark,
    );
  } catch (error) {
    input.onBusyChange(false);
    const message =
      error instanceof WrongPasswordError
        ? error.message
        : "That PIN did not work.";
    input.noteFailure("PIN confirmation", message);
    input.setMark(message);
  }
}
