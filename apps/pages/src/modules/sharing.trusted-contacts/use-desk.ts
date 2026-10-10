/**
 * What every panel of Settings › Trusted contacts stands on: the desk's ports
 * for this open vault, and the records it holds (ADR 0186 §10).
 *
 * `null` while the vault is locked, a guest or a decoy: a circle holds an owner
 * key and a guardian a wrapped share, and neither survives a session that is
 * thrown away, so those panels draw nothing at all (ADR 0158: absent, not
 * disabled).
 *
 * The records are items of the open vault, so they are read from its snapshot:
 * a ceremony step that saves one changes the snapshot, and every panel that
 * asks for the desk is drawn again with the new list, with no polling and no
 * second copy to keep in step.
 */

import {
  type Ceremony,
  webauthnCeremony,
} from "@opensesame/app-core/lib/quorum/ceremony.js";
import type {
  DeskPorts,
  OwnedRecord,
} from "@opensesame/app-core/lib/quorum/desk/index.js";
import type { HeldRecord } from "@opensesame/app-core/lib/quorum/records.js";
import type { VaultState } from "@opensesame/app-core/lib/vault/store.js";
import { maybePage } from "@opensesame/app-core/ports.js";
import { useCallback, useMemo, useReducer } from "react";
import { useVault, useVaultStore } from "../../lib/vault/hooks.js";
import { tombPendingStore } from "./pending-store.js";
import {
  type RecordsVault,
  type UnreadableRecord,
  scanHeld,
  scanOwned,
  unreadableRecords,
  vaultRecordStore,
} from "./vault-records.js";

export type Desk = Readonly<{
  ports: DeskPorts;
  owned: readonly OwnedRecord[];
  held: readonly HeldRecord[];
  /** Read the records again after a ceremony step changed them. */
  refresh(): Promise<void>;
}>;

/**
 * Replaceable in tests (`vi.mock` is not allowed in this repo): a test sets
 * `deskSeams.useDesk` to hand a panel a desk built on in-memory stores.
 */
export type DeskSeams = { useDesk: () => Desk | null };

export const deskSeams: DeskSeams = {
  useDesk: realUseDesk,
};

export function useDesk(): Desk | null {
  return deskSeams.useDesk();
}

/**
 * The page's own credentials, looked up when a key is touched rather than
 * when the desk is built: a browser with no WebAuthn still lists circles, and
 * the step that needs a key is the one that says so.
 */
const pageCeremony: Ceremony = {
  register: async (input) => webauthnCeremony().register(input),
  assert: async (input) => webauthnCeremony().assert(input),
};

function deskPorts(store: RecordsVault, tomb: string): DeskPorts | null {
  const page = maybePage();
  if (!page) return null;
  return {
    now: () => new Date(),
    origin: page.location.origin,
    rpId: page.location.hostname,
    ceremony: pageCeremony,
    pending: tombPendingStore(tomb),
    records: vaultRecordStore(store),
    tomb,
  };
}

/**
 * One set of ports per open vault, shared by every panel and sheet that asks:
 * they hold nothing a lock must take away (the tomb's key is the VFS's), so a
 * consumer keyed on `ports` does not start over for a re-render.
 */
const built = new WeakMap<RecordsVault, { tomb: string; ports: DeskPorts }>();

function portsFor(store: RecordsVault, tomb: string): DeskPorts | null {
  const kept = built.get(store);
  if (kept?.tomb === tomb) return kept.ports;
  const ports = deskPorts(store, tomb);
  if (ports) built.set(store, { tomb, ports });
  return ports;
}

/** The tomb circles may be kept in, or `null` where nothing may be. */
function circleTomb(vault: VaultState): string | null {
  if (vault.status !== "unlocked" || vault.guest || vault.decoy) return null;
  return vault.tomb === "" ? null : vault.tomb;
}

export function realUseDesk(): Desk | null {
  const vault = useVault();
  const store = useVaultStore();
  const [, again] = useReducer((turn: number) => turn + 1, 0);
  const tomb = circleTomb(vault);
  const ports = useMemo(
    () => (tomb === null ? null : portsFor(store, tomb)),
    [store, tomb],
  );
  const owned = useMemo(
    () => (ports === null ? [] : scanOwned(vault.items).records),
    [ports, vault.items],
  );
  const held = useMemo(
    () => (ports === null ? [] : scanHeld(vault.items).records),
    [ports, vault.items],
  );
  // The snapshot is read on every render, so asking for one is asking to be
  // drawn again with the store as it is now.
  const refresh = useCallback(async () => again(), []);
  return useMemo(
    () => (ports === null ? null : { ports, owned, held, refresh }),
    [ports, owned, held, refresh],
  );
}

const NONE: readonly UnreadableRecord[] = [];

/**
 * The circle and share items of this vault that cannot be used (their signed
 * policy no longer verifies, or they do not read), so a row can be marked and
 * offered for removal. Empty where the desk is absent.
 */
export function useUnreadableRecords(): readonly UnreadableRecord[] {
  const vault = useVault();
  const usable = circleTomb(vault) !== null;
  return useMemo(
    () => (usable ? unreadableRecords(vault.items) : NONE),
    [usable, vault.items],
  );
}
