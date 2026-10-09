/** Existing data presentation only; never an owner permission issuer. */
import {
  type VaultBody,
  type VaultHeader,
  resolveAccounts,
} from "@opensesame/vault-core";
import {
  isDecoySession,
  presentedTomb,
} from "../duress/store/decoy-scratch.js";
import { kvDurability } from "../kv.js";
import { BODY_PATH, readSealedFile } from "../vfs.js";
import type { VaultPrefs } from "./prefs.js";
import type { VaultState } from "./store-state.js";

type VaultStateData = {
  header: VaultHeader | null;
  open: boolean;
  pending: boolean;
  ephemeral: boolean;
  tomb: string;
  body: VaultBody;
  prefs: VaultPrefs;
  attempts: { until: number; fails: number };
};

export function buildVaultState({
  header,
  open,
  pending,
  ephemeral,
  tomb,
  body,
  prefs,
  attempts,
}: VaultStateData): VaultState {
  return {
    status: open ? "unlocked" : header ? "locked" : "empty",
    tomb: presentedTomb(tomb),
    guest: ephemeral && open,
    decoy: ephemeral && open && isDecoySession(),
    header,
    items: resolveAccounts(body.items),
    rawItems: body.items,
    folders: body.folders,
    prefs,
    lockedOutUntil: attempts.until > Date.now() ? attempts.until : null,
    failedAttempts: attempts.fails,
    awaitingSecondStep: pending && !open,
    durable: kvDurability() !== "memory",
  };
}

/** Preserve existing sealed-export behavior; caller owns any future REAL-boundary admission. */
export function exportStoredVault(
  tomb: string,
  header: VaultHeader | null,
): string {
  if (!header) throw new Error("There is no vault to export.");
  const body = readSealedFile(tomb, BODY_PATH);
  if (!body) throw new Error("There is nothing stored to export yet.");
  return JSON.stringify(
    {
      format: "opensesame-vault-export",
      v: 1,
      exportedAt: new Date().toISOString(),
      tomb,
      header,
      body,
    },
    null,
    2,
  );
}
