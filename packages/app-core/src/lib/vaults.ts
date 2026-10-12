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

import {
  type OrgVaultRef,
  formatOrgVaultRef,
  parseOrgVaultRef,
} from "@opensesame/os-domain";
import type { VaultHeader } from "@opensesame/vault-core";
import { guestsAllowed } from "./guest-access.js";
import { kvHydrate } from "./kv.js";
import { guestVaultLabel } from "./local-guest.js";

export { guestVaultLabel } from "./local-guest.js";
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
  /**
   * Published `owner/slug` when the tomb header carries one that still
   * parses. Guest rows leave this unset. The sealed display name stays
   * `label` once it is known.
   */
  readonly address?: OrgVaultRef | null;
};

/** The guest road as a row: not a vault on disk, but a peer in the list. */
export function guestVault(state: DeviceVaultState = "empty"): DeviceVault {
  return {
    id: GUEST_TOMB,
    kind: "guest",
    label: guestVaultLabel(),
    named: true,
    sealedAt: null,
    state,
    sharedKey: false,
    address: null,
  };
}

/**
 * What a vault is called on screen. Before unlock a project's name is sealed
 * inside it, so its label is the tomb kind and the tail of its id — enough to
 * tell two apart, and nothing that was ever typed as a name.
 */
export function vaultLabel(project: Pick<PagesProject, "id" | "name">): string {
  if (project.id === PERSONAL_PROJECT_ID) return "personal";
  if (project.id === GUEST_TOMB) return guestVaultLabel();
  if (project.name && project.name !== project.id) return project.name;
  return `project · ${project.id.replace(/^prj_/, "").slice(-4)}`;
}

/**
 * What the open vault is called — the prompt's name for it, so the list's
 * status line and the prompt never disagree (`guest-2` above, `personal:/`
 * below was one vault under two names).
 */
export function openVaultLabel(): string {
  const snapshot = vaultStore.getSnapshot();
  return snapshot.guest && !snapshot.decoy
    ? guestVaultLabel()
    : vaultLabel(activeProject());
}

/**
 * The address a tomb header published, or null when it is missing or does
 * not parse. The header field is plaintext metadata; this re-checks it.
 */
export function publishedAddressOf(
  header: VaultHeader | null,
): OrgVaultRef | null {
  const raw = header?.publishedAddress;
  if (!raw) return null;
  if (raw.ownerKind !== "user" && raw.ownerKind !== "organization") return null;
  const parsed = parseOrgVaultRef(`${raw.owner}/${raw.slug}`, raw.ownerKind);
  return parsed.ok ? parsed.ref : null;
}

/** `owner/slug` for a row that carries an address, else nothing. */
export function vaultAddressLabel(
  vault: Pick<DeviceVault, "address">,
): string | null {
  return vault.address ? formatOrgVaultRef(vault.address) : null;
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
  // A decoy is drawn as the vault the unlock screen was showing: the active one.
  const open =
    snapshot.status === "unlocked" &&
    (snapshot.decoy
      ? project.id === activeProject().id
      : snapshot.tomb === project.id && !snapshot.guest);
  const named = project.name !== project.id;
  const address = publishedAddressOf(header);
  const spelled = address ? formatOrgVaultRef(address) : null;
  return {
    id: project.id,
    kind: project.id === PERSONAL_PROJECT_ID ? "personal" : "project",
    label: spelled && !named ? spelled : vaultLabel(project),
    named,
    sealedAt: header?.createdAt ?? null,
    state: open ? "open" : header ? "locked" : "empty",
    sharedKey: !open && vaultStore.sharesKeyWith(header),
    address,
  };
}

/**
 * Every vault on this device, the personal one first, then the projects in
 * the order they were made, then the guest row while guests are allowed. A
 * guest session that is open right now reports as open on the guest row and
 * nowhere else.
 */
function listDeviceVaultsDefault(): DeviceVault[] {
  const snapshot = vaultStore.getSnapshot();
  const guestOpen =
    snapshot.status === "unlocked" && snapshot.guest && !snapshot.decoy;
  // With guests switched off there is no guest row to open (ADR 0135 §4),
  // unless a guest session is the one open right now.
  const guestRow = guestOpen
    ? [guestVault("open")]
    : guestsAllowed()
      ? [guestVault()]
      : [];
  return [
    ...listProjects()
      .filter((project) => project.id !== GUEST_TOMB)
      .map(describeVault),
    ...guestRow,
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
let deviceVaultsRevision = 0;
export function subscribeDeviceVaults(listener: () => void): () => void {
  const bump = () => {
    deviceVaultsRevision += 1;
    listener();
  };
  const unsubscribeProjects = subscribeProjects(bump);
  const unsubscribeStore = vaultStore.subscribe(bump);
  return () => {
    unsubscribeProjects();
    unsubscribeStore();
  };
}

/** The version `subscribeDeviceVaults` bumps; React binds it in bindings/vaults.ts. */
export function deviceVaultsVersion(): number {
  return deviceVaultsRevision;
}

/**
 * One vault mutation at a time. A switch yields on durable I/O between
 * choosing a tomb and scoping the store to it, so two switches fired
 * together would interleave and could scope — or fork a header into — the
 * wrong tomb. Every switch/seal/remove verb runs through this chain, and a
 * queued mutation that fails does not poison the next one.
 */
let switchChain: Promise<unknown> = Promise.resolve();

function enqueueVaultMutation<T>(task: () => Promise<T>): Promise<T> {
  const run = switchChain.then(task, task);
  switchChain = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
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
  if (activeProject().id !== tomb) {
    throw new Error("The active vault changed while switching; try again.");
  }
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
  return enqueueVaultMutation(async () => {
    if (id === GUEST_TOMB) {
      switchToGuestNow();
      // Guest has no enrolled key — UnlockScreen shows a single Unlock button.
      return "locked";
    }
    const target = listProjects().find((project) => project.id === id);
    if (!target) {
      throw new Error("That vault no longer exists on this device.");
    }
    const sharedKey = vaultStore.sharesKeyWith(readTombHeader(id));
    await setActiveProject(id);
    await enterActiveProjectScope(sharedKey);
    return vaultStore.isUnlocked() ? "opened" : "locked";
  });
}

function switchToGuestNow(): void {
  if (vaultStore.isUnlocked()) vaultStore.lock();
  vaultStore.prepareGuestUnlock();
}

/**
 * The guest road from anywhere: an open vault locks first (a guest never
 * runs beside an open session), then unlock points at the guest tomb.
 * Unlock / Continue-as-guest opens the session. Never gated (AGENTS.md §5).
 */
export async function switchToGuest(): Promise<void> {
  await enqueueVaultMutation(async () => switchToGuestNow());
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
  return enqueueVaultMutation(async () => {
    const project = await createProject(name);
    await setActiveProject(project.id);
    await enterActiveProjectScope(options.shareKey);
    return project;
  });
}

/** Remove a vault from this device. Never the personal one, never the open one. */
async function removeVaultDefault(id: string): Promise<void> {
  return enqueueVaultMutation(async () => {
    const snapshot = vaultStore.getSnapshot();
    const openHere =
      snapshot.status === "unlocked" &&
      (snapshot.tomb === id || (id === GUEST_TOMB && snapshot.guest));
    if (openHere) {
      throw new Error("Lock this vault before deleting it.");
    }
    await deleteProject(id);
  });
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
