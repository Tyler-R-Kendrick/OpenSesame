/**
 * `opensesame-id vault sync [--pair <code>]` — tailnet vault sync from a
 * terminal (ADR 0144), the same pass the Pages app runs:
 *
 *   - no vault here and a code: the vault is set up from the drive, then
 *     opened with its master password from the terminal;
 *   - a vault here: it is opened, merged with the drive's copy, and the
 *     drive replaced when it lacks something this device holds.
 *
 * A code given once is sealed in the vault, so a later `vault sync` needs
 * none. Nothing printed names an item or a value: only what moved.
 */
import {
  assertAuthenticationSession,
  assertNotDecoySession,
} from "@opensesame/app-core/lib/decoy-session.js";
import { flushRetiredCredentialTelemetry } from "@opensesame/app-core/lib/retired-credentials/index.js";
import { adoptSnapshot } from "@opensesame/app-core/lib/tailnet-sync/adopt.js";
import {
  readDriveConfig,
  writeDriveConfig,
} from "@opensesame/app-core/lib/tailnet-sync/config.js";
import {
  type DriveTransport,
  defaultTransport,
  syncOnce,
} from "@opensesame/app-core/lib/tailnet-sync/engine.js";
import {
  type DrivePairing,
  parsePairingCode,
} from "@opensesame/app-core/lib/tailnet-sync/pairing.js";
import type { VaultStore } from "@opensesame/app-core/lib/vault/store.js";
import { pinTombAuthority } from "@opensesame/app-core/lib/vfs.js";
import { defaultStateDir } from "@opensesame/app-core/node/host.js";
import { emit } from "./output.js";
import type { ParsedCommand } from "./parse.js";
import { readPasswordFromTty } from "./tty-password.js";
import { releaseVaultKv } from "./vault-kv.js";
import { openLocalVault, unlockLocalVault } from "./vault-session.js";

type SyncCommand = Extract<ParsedCommand, { name: "vault-sync" }>;

export interface VaultSyncDependencies {
  stateDir?: string;
  readPassword?: (prompt: string) => Promise<string>;
  transport?: DriveTransport;
}

export type VaultSyncResult = {
  adopted: boolean;
  pulled: boolean;
  pushed: boolean;
  generation: number;
  drive: string;
};

function pairingFrom(code: string | undefined): DrivePairing | null {
  if (code === undefined) return null;
  const pairing = parsePairingCode(code);
  if (!pairing) throw new Error("That is not a drive pairing code.");
  return pairing;
}

function guardedTransport(
  transport: DriveTransport,
  assertAuthority: () => void,
): DriveTransport {
  return {
    async read(pairing, saved) {
      assertAuthority();
      try {
        return await transport.read(pairing, saved);
      } finally {
        assertAuthority();
      }
    },
    async write(pairing, generation, snapshot, saved) {
      assertAuthority();
      try {
        return await transport.write(pairing, generation, snapshot, saved);
      } finally {
        assertAuthority();
      }
    },
  };
}

async function syncOwnerVault(
  vaultStore: VaultStore,
  given: DrivePairing | null,
  transport: DriveTransport,
): Promise<Omit<VaultSyncResult, "adopted">> {
  assertNotDecoySession();
  const state = vaultStore.getSnapshot();
  if (state.status !== "unlocked" || state.guest || state.awaitingSecondStep)
    throw new Error(
      "Complete real owner authentication before syncing a vault.",
    );
  const tomb = vaultStore.activeTomb();
  const assertAuthority = pinTombAuthority(tomb);
  const pairing = given ?? (await readDriveConfig(tomb));
  assertAuthority();
  if (!pairing) {
    throw new Error(
      "This vault is not paired with a drive. Pass --pair <code> once.",
    );
  }
  const outcome = await syncOnce(
    vaultStore,
    pairing,
    guardedTransport(transport, assertAuthority),
  );
  assertAuthority();
  if (given) await writeDriveConfig(tomb, given);
  assertAuthority();
  await vaultStore.flushPendingWrites();
  assertAuthority();
  return { ...outcome, drive: pairing.url };
}

export async function syncVault(
  command: SyncCommand,
  deps: VaultSyncDependencies = {},
): Promise<VaultSyncResult> {
  const stateDir = deps.stateDir ?? defaultStateDir();
  const readPassword = deps.readPassword ?? readPasswordFromTty;
  const transport = deps.transport ?? defaultTransport;
  const given = pairingFrom(command.code);
  const vaultStore = await openLocalVault(stateDir);
  try {
    const startingRealm = assertAuthenticationSession();
    let adopted = false;
    if (vaultStore.getSnapshot().status === "empty") {
      if (!given) {
        throw new Error(
          "There is no vault here yet. Pass --pair <code> to set it up from a drive.",
        );
      }
      assertNotDecoySession(startingRealm);
      const { snapshot } = await transport.read(given);
      assertNotDecoySession(startingRealm);
      if (!snapshot) {
        throw new Error(
          "The drive is empty. Sync from a device that holds the vault first.",
        );
      }
      adopted = (await adoptSnapshot(snapshot)) === "adopted";
      assertNotDecoySession(startingRealm);
      vaultStore.rehydrate();
    }
    const password = await readPassword("Master password: ");
    assertAuthenticationSession(startingRealm);
    await unlockLocalVault(vaultStore, password);
    return { adopted, ...(await syncOwnerVault(vaultStore, given, transport)) };
  } finally {
    try {
      await flushRetiredCredentialTelemetry();
    } finally {
      await releaseVaultKv();
    }
  }
}

export async function runVaultSync(
  command: SyncCommand,
  deps: VaultSyncDependencies = {},
): Promise<number> {
  const result = await syncVault(command, deps);
  const moved = [
    result.adopted ? "set up from the drive" : null,
    result.pulled ? "took in changes" : null,
    result.pushed ? "sent changes" : null,
  ].filter((part) => part !== null);
  emit(
    command.flags,
    `${result.drive}: ${moved.length > 0 ? moved.join(", ") : "in step"} (generation ${result.generation})`,
    result,
  );
  return 0;
}
