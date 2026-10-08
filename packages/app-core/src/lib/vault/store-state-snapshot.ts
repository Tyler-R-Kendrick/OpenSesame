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
import { tombRealmAuthorized } from "../vfs-authority.js";
import { type VaultPrefs, defaultPrefs } from "./prefs.js";
import type { VaultScope } from "./store-scope.js";
import type { VaultState } from "./store-state.js";
import { readAttempts } from "./unlock-attempts.js";
type StoreStateInput = {
  scope: VaultScope;
  unlocked: boolean;
  ephemeral: boolean;
  pending: boolean;
  header: VaultHeader | null;
  body: VaultBody;
  prefs: VaultPrefs;
};

/** Project session state without exposing or retaining its protected keys. */
export function buildVaultState(input: StoreStateInput): VaultState {
  const attempts = readAttempts(input.scope.attempts);
  return {
    status: input.unlocked ? "unlocked" : input.header ? "locked" : "empty",
    tomb: presentedTomb(input.scope.tomb),
    guest: input.ephemeral && input.unlocked,
    decoy: input.ephemeral && input.unlocked && isDecoySession(),
    header: input.header,
    items: resolveAccounts(input.body.items),
    rawItems: input.body.items,
    folders: input.body.folders,
    prefs: input.prefs,
    lockedOutUntil: attempts.until > Date.now() ? attempts.until : null,
    failedAttempts: attempts.fails,
    awaitingSecondStep: input.pending && !input.unlocked,
    durable: kvDurability() !== "memory",
  };
}

const deniedSnapshots = new WeakMap<VaultState, VaultState>();
/** A retained real store exposes no owner data to another synthetic principal. */
export function visibleVaultState(
  snapshot: VaultState,
  tomb: string,
  key: CryptoKey | null,
): VaultState {
  if (tombRealmAuthorized(tomb, key)) return snapshot;
  let denied = deniedSnapshots.get(snapshot);
  if (!denied) {
    denied = {
      status: "locked",
      tomb: "guest",
      guest: false,
      decoy: false,
      header: null,
      items: [],
      folders: [],
      prefs: { ...defaultPrefs },
      lockedOutUntil: null,
      failedAttempts: 0,
      awaitingSecondStep: false,
      durable: snapshot.durable,
    };
    deniedSnapshots.set(snapshot, denied);
  }
  return denied;
}
export function isVisibleStoreUnlocked(
  tomb: string,
  key: CryptoKey | null,
): boolean {
  return key !== null && tombRealmAuthorized(tomb, key);
}
