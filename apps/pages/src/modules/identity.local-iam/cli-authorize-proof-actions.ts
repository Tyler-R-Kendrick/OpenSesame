import type { VaultHeader } from "@opensesame/vault-core";
import { WrongPasswordError } from "@opensesame/vault-core";
import type { FormEvent } from "react";
import type { CliAuthorizeRow } from "./cli-authorize-mint-proof.js";

async function finishApprove(
  humanProof: string,
  onRespond: (
    decision: "approve" | "deny",
    humanProof?: string,
  ) => Promise<boolean>,
  onDone: () => void,
  noteFailure: (title: string, message: string) => void,
  setMark: (message: string) => void,
) {
  const ok = await onRespond("approve", humanProof);
  if (ok) {
    onDone();
    return;
  }
  noteFailure("CLI authorization failed", "That did not work.");
  setMark("That did not work.");
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
  noteFailure: (title: string, message: string) => void;
  setMark: (message: string) => void;
  clearMark: () => void;
  onNeedPin: () => void;
}): Promise<void> {
  if (input.busy) return;
  input.onBusyChange(true);
  input.clearMark();
  try {
    const { mintCliAuthorizePasskeyProof } = await import(
      "./cli-authorize-mint-proof.js"
    );
    const proof = await mintCliAuthorizePasskeyProof(input.row);
    input.onBusyChange(false);
    await finishApprove(
      proof,
      input.onRespond,
      input.onDone,
      input.noteFailure,
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
    input.onNeedPin();
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
  noteFailure: (title: string, message: string) => void;
  setMark: (message: string) => void;
  clearMark: () => void;
  event: FormEvent;
}): Promise<void> {
  input.event.preventDefault();
  if (input.busy) return;
  input.onBusyChange(true);
  input.clearMark();
  try {
    const { mintCliAuthorizePinProof } = await import(
      "./cli-authorize-mint-proof.js"
    );
    const proof = await mintCliAuthorizePinProof(
      input.row,
      input.pin,
      input.header,
    );
    input.onBusyChange(false);
    await finishApprove(
      proof,
      input.onRespond,
      input.onDone,
      input.noteFailure,
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
