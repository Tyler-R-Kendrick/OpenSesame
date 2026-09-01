/**
 * The vaults on this device, and moving between them (ADR 0089).
 *
 * A device holds several tombs at once: the personal vault, a tomb per
 * project, and the guest tomb a guest session runs in beside a sealed vault.
 * This module is the one view of that set the app renders — the front door
 * before any unlock, the `@tomb` prompt inside a vault, and the Manage panel
 * — so every surface agrees on what a vault is called and what state it is in.
 *
 * Two facts shape it:
 *
 *  - A vault's display name is a secret. It lives in `config/projects` inside
 *    the sealed tomb, so before unlock the only plaintext facts about a
 *    project tomb are its id and its header's `createdAt`. `vaultLabel` says
 *    `project · 4f2a` then, never a leaked name.
 *  - Switching locks the current vault, with one exception: a project sealed
 *    with this session's key (`store.sharesKeyWith`) opens without a prompt.
 *    The row says which it will be before the person commits.
 */

import { useMemo, useSyncExternalStore } from "react";
import { continueAsGuest } from "./guest-auth.js";
import { kvHydrate } from "./kv.js";
import {
  PERSONAL_PROJECT_ID,
  type PagesProject,
  activeProject,
  createProject,
  deleteProject,
  listProjects,
  projectScopedKeys,
  setActiveProject,
  subscribeProjects,
} from "./projects.js";
import { GUEST_TOMB, readTombHeader, vaultStore } from "./vault/store.js";
import {
  migrateLegacyVaultStorage,
  tombStorageKeys,
} from "./vault/tomb-migration.js";

export type DeviceVaultKind = "personal" | "project" | "guest";

export type DeviceVaultState =
  /** The tomb this session is scoped to, and it is open. */
  | "open"
  /** A sealed vault; unlocking is what opening it means. */
  | "locked"
  /** Registered but never sealed — it opens by sealing it. */
  | "empty";

export type DeviceVault = {
  /** The tomb name — a project id, `personal`, or `guest`. */
  readonly id: string;
  readonly kind: DeviceVaultKind;
  /** What to call it — a sealed name once known, else a label from the id. */
  readonly label: string;
  /** True when `label` is a real name rather than derived from the id. */
  readonly named: boolean;
  /** When the tomb was sealed, from its plaintext header. */
  readonly sealedAt: string | null;
  readonly state: DeviceVaultState;
  /** Opens with the key this session already holds — no prompt on switch. */
  readonly sharedKey: boolean;
};

/** The guest road as a row: not a vault on disk, but a peer in the list. */
export const GUEST_VAULT: DeviceVault = {
  id: GUEST_TOMB,
  kind: "guest",
  label: "guest",
  named: true,
  sealedAt: null,
  state: "empty",
  sharedKey: false,
};

/**
 * What a vault is called on screen. Before unlock a project's name is sealed
 * inside it, so its label is the tomb kind and the tail of its id — enough to
 * tell two apart, and nothing that was ever typed as a name.
 */
export function vaultLabel(project: Pick<PagesProject, "id" | "name">): string {
  if (project.id === PERSONAL_PROJECT_ID) return "personal";
  if (project.id === GUEST_TOMB) return "guest";
  if (project.name && project.name !== project.id) return project.name;
  return `project · ${project.id.replace(/^prj_/, "").slice(-4)}`;
}

/** `sealed 14 Aug 2026`, or nothing for a tomb that was never sealed. */
export function describeSealedAt(sealedAt: string | null): string | null {
  if (!sealedAt) return null;
  const date = new Date(sealedAt);
  if (Number.isNaN(date.getTime())) return null;
  return `sealed ${date.toLocaleDateString(undefined, {
    day: "numeric",
    month: "short",
    year: "numeric",
  })}`;
}

function describeVault(project: PagesProject): DeviceVault {
  const snapshot = vaultStore.getSnapshot();
  const header = readTombHeader(project.id);
  // A guest session that happens to run in this tomb (a first-run guest
  // lives in `personal`) is the guest row's to report, not this vault's.
  const open =
    snapshot.status === "unlocked" &&
    snapshot.tomb === project.id &&
    !snapshot.guest;
  const named = project.name !== project.id;
  return {
    id: project.id,
    kind: project.id === PERSONAL_PROJECT_ID ? "personal" : "project",
    label: vaultLabel(project),
    named,
    sealedAt: header?.createdAt ?? null,
    state: open ? "open" : header ? "locked" : "empty",
    sharedKey: !open && vaultStore.sharesKeyWith(header),
  };
}

/**
 * Every vault on this device, the personal one first, then the projects in
 * the order they were made, then the guest row. A guest session that is open
 * right now reports as open on the guest row and nowhere else.
 */
function listDeviceVaultsDefault(): DeviceVault[] {
  const snapshot = vaultStore.getSnapshot();
  const guestOpen = snapshot.status === "unlocked" && snapshot.guest;
  return [
    ...listProjects().map(describeVault),
    guestOpen ? { ...GUEST_VAULT, state: "open" as const } : GUEST_VAULT,
  ];
}

/** Whether the switcher has anything to offer beyond the one vault. */
function deviceHasSeveralVaultsDefault(): boolean {
  return listProjects().length > 1;
}

/**
 * The list, for a component: re-derived only when the projects view or the
 * vault store actually emits, not on every render or every keystroke.
 */
let deviceVaultsVersion = 0;
function subscribeDeviceVaults(listener: () => void): () => void {
  const bump = () => {
    deviceVaultsVersion += 1;
    listener();
  };
  const unsubscribeProjects = subscribeProjects(bump);
  const unsubscribeStore = vaultStore.subscribe(bump);
  return () => {
    unsubscribeProjects();
    unsubscribeStore();
  };
}

export function useDeviceVaults(): DeviceVault[] {
  const version = useSyncExternalStore(
    subscribeDeviceVaults,
    () => deviceVaultsVersion,
    () => -1,
  );
  return useMemo(() => (version < 0 ? [] : listDeviceVaults()), [version]);
}

/**
 * Bring the active project's keys into this tab and hand the store its
 * scope. `carryKey` is the shared-key road: the store opens the tomb with
 * the key in hand (a new tomb is forked; a sealed one is verified to share
 * the wrap), and anything else falls back to a plain scope swap, which locks.
 */
export async function enterActiveProjectScope(
  carryKey: boolean,
): Promise<void> {
  const tomb = activeProject().id;
  await kvHydrate([...projectScopedKeys(), ...tombStorageKeys(tomb)]);
  await migrateLegacyVaultStorage(tomb);
  // A guest's key was never wrapped to disk: nothing to carry, ever.
  if (carryKey && vaultStore.isUnlocked() && !vaultStore.getSnapshot().guest) {
    if (readTombHeader(tomb)) {
      await vaultStore.openActiveScopeWithCurrentKey();
    } else {
      await vaultStore.forkUnlockedIntoActiveScope();
    }
    return;
  }
  vaultStore.loadActiveProjectScope();
}

export type SwitchOutcome =
  /** Open, no prompt: the vault shared this session's key. */
  | "opened"
  /** The unlock screen for that vault is what comes next. */
  | "locked";

/**
 * Switch to a vault. A shared-key project opens straight away; any other
 * vault locks the current one and lands on its unlock screen, which is the
 * cost the switcher names before the person picks.
 */
async function switchVaultDefault(id: string): Promise<SwitchOutcome> {
  if (id === GUEST_TOMB) {
    await switchToGuest();
    return "opened";
  }
  const target = listProjects().find((project) => project.id === id);
  if (!target) {
    throw new Error("That vault no longer exists on this device.");
  }
  const sharedKey = vaultStore.sharesKeyWith(readTombHeader(id));
  await setActiveProject(id);
  await enterActiveProjectScope(sharedKey);
  return vaultStore.isUnlocked() ? "opened" : "locked";
}

/**
 * The guest road from anywhere: an open vault locks first (a guest never
 * runs beside an open session), then the store seals a guest session in the
 * isolated guest tomb. Never gated on anything (AGENTS.md §5).
 */
export async function switchToGuest(): Promise<void> {
  if (vaultStore.isUnlocked()) vaultStore.lock();
  await continueAsGuest();
}

/**
 * Seal a new vault. `shareKey` forks this session's key into it so it opens
 * without a prompt from then on; otherwise it is created empty and its own
 * seal ceremony (passkey, PIN or password) is what comes next.
 */
async function sealNewVaultDefault(
  name: string,
  options: { shareKey: boolean },
): Promise<PagesProject> {
  const project = await createProject(name);
  await setActiveProject(project.id);
  await enterActiveProjectScope(options.shareKey);
  return project;
}

/** Remove a vault from this device. Never the personal one, never the open one. */
async function removeVaultDefault(id: string): Promise<void> {
  const snapshot = vaultStore.getSnapshot();
  const openHere =
    snapshot.status === "unlocked" &&
    (snapshot.tomb === id || (id === GUEST_TOMB && snapshot.guest));
  if (openHere) {
    throw new Error("Lock this vault before deleting it.");
  }
  await deleteProject(id);
}

export const vaultsSeams = {
  listDeviceVaults: listDeviceVaultsDefault,
  deviceHasSeveralVaults: deviceHasSeveralVaultsDefault,
  switchVault: switchVaultDefault,
  sealNewVault: sealNewVaultDefault,
  removeVault: removeVaultDefault,
};

export function listDeviceVaults(): DeviceVault[] {
  return vaultsSeams.listDeviceVaults();
}

export function deviceHasSeveralVaults(): boolean {
  return vaultsSeams.deviceHasSeveralVaults();
}

export async function switchVault(id: string): Promise<SwitchOutcome> {
  return vaultsSeams.switchVault(id);
}

export async function sealNewVault(
  name: string,
  options: { shareKey: boolean },
): Promise<PagesProject> {
  return vaultsSeams.sealNewVault(name, options);
}

export async function removeVault(id: string): Promise<void> {
  return vaultsSeams.removeVault(id);
}
