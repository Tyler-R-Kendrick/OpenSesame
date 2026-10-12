import type { VaultHeader } from "@opensesame/vault-core";
import { WrongPasswordError } from "@opensesame/vault-core";
import type { FormEvent } from "react";
import type { CliAuthorizeRow } from "./cli-authorize-mint-proof.js";

export async function runCliAuthorizePasskeyApprove(input: {
  row: CliAuthorizeRow;
  busy: boolean;
  setBusy: (busy: boolean) => void;
  setMark: (mark: string | null) => void;
  setHeader: (header: VaultHeader | null) => void;
  setPinOpen: (open: boolean) => void;
  finish: (decision: "approve" | "deny", humanProof?: string) => Promise<void>;
}): Promise<void> {
  if (input.busy) return;
  input.setBusy(true);
  input.setMark(null);
  try {
    const { mintCliAuthorizePasskeyProof } = await import(
      "./cli-authorize-mint-proof.js"
    );
    const proof = await mintCliAuthorizePasskeyProof(input.row);
    input.setBusy(false);
    await input.finish("approve", proof);
  } catch (error) {
    input.setBusy(false);
    input.setMark(
      error instanceof WrongPasswordError
        ? error.message
        : "Passkey confirmation was cancelled.",
    );
    const { vaultStore } = await import(
      "@opensesame/app-core/lib/vault/store.js"
    );
    const loadedHeader = vaultStore.getSnapshot().header;
    input.setHeader(loadedHeader);
    if (loadedHeader?.unlocks?.pin) input.setPinOpen(true);
  }
}

export async function runCliAuthorizePinApprove(input: {
  row: CliAuthorizeRow;
  pin: string;
  header: VaultHeader | null;
  busy: boolean;
  setBusy: (busy: boolean) => void;
  setMark: (mark: string | null) => void;
  setHeader: (header: VaultHeader | null) => void;
  finish: (decision: "approve" | "deny", humanProof?: string) => Promise<void>;
  event: FormEvent;
}): Promise<void> {
  input.event.preventDefault();
  if (input.busy) return;
  let vaultHeader = input.header;
  if (!vaultHeader) {
    const { vaultStore } = await import(
      "@opensesame/app-core/lib/vault/store.js"
    );
    vaultHeader = vaultStore.getSnapshot().header;
    input.setHeader(vaultHeader);
  }
  if (!vaultHeader) return;
  input.setBusy(true);
  input.setMark(null);
  try {
    const { mintCliAuthorizePinProof } = await import(
      "./cli-authorize-mint-proof.js"
    );
    const proof = await mintCliAuthorizePinProof(
      input.row,
      input.pin,
      vaultHeader,
    );
    input.setBusy(false);
    await input.finish("approve", proof);
  } catch (error) {
    input.setBusy(false);
    input.setMark(
      error instanceof WrongPasswordError
        ? error.message
        : "That PIN did not work.",
    );
  }
}
