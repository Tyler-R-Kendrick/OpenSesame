import type { VaultHeader } from "@opensesame/vault-core";
import { WrongPasswordError } from "@opensesame/vault-core";
import type { CliAuthorizeRow } from "./cli-authorize-session.js";

export async function mintPasskeyProof(row: CliAuthorizeRow): Promise<string> {
  const { mintCliAuthorizePasskeyProof } = await import(
    "./cli-authorize-mint-proof.js"
  );
  return mintCliAuthorizePasskeyProof(row);
}

export async function mintPinProof(
  row: CliAuthorizeRow,
  pin: string,
  header: VaultHeader,
): Promise<string> {
  const { mintCliAuthorizePinProof } = await import(
    "./cli-authorize-mint-proof.js"
  );
  return mintCliAuthorizePinProof(row, pin, header);
}

export function passkeyProofErrorMessage(error: unknown): string {
  return error instanceof WrongPasswordError
    ? error.message
    : "Passkey confirmation was cancelled.";
}

export function pinProofErrorMessage(error: unknown): string {
  return error instanceof WrongPasswordError
    ? error.message
    : "That PIN did not work.";
}

export async function runPasskeyApprove(input: {
  row: CliAuthorizeRow;
  busy: boolean;
  onBusyChange: (busy: boolean) => void;
  onApprove: (humanProof: string) => Promise<void>;
  onError: (title: string, message: string) => void;
  clearMark: () => void;
  setMark: (message: string) => void;
}): Promise<void> {
  if (input.busy) return;
  input.onBusyChange(true);
  input.clearMark();
  try {
    await input.onApprove(await mintPasskeyProof(input.row));
  } catch (error) {
    const message = passkeyProofErrorMessage(error);
    input.onError("Passkey confirmation", message);
    input.setMark(message);
  } finally {
    input.onBusyChange(false);
  }
}

export async function runPinApprove(input: {
  row: CliAuthorizeRow;
  pin: string;
  header: VaultHeader;
  busy: boolean;
  event: { preventDefault: () => void };
  onBusyChange: (busy: boolean) => void;
  onApprove: (humanProof: string) => Promise<void>;
  onError: (title: string, message: string) => void;
  clearMark: () => void;
  setMark: (message: string) => void;
}): Promise<void> {
  input.event.preventDefault();
  if (input.busy) return;
  input.onBusyChange(true);
  input.clearMark();
  try {
    await input.onApprove(
      await mintPinProof(input.row, input.pin, input.header),
    );
  } catch (error) {
    const message = pinProofErrorMessage(error);
    input.onError("PIN confirmation", message);
    input.setMark(message);
  } finally {
    input.onBusyChange(false);
  }
}
