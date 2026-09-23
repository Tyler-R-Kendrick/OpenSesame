/**
 * Guest principals are unclaimed and per-session — never a shared singleton.
 * Each Continue-as-guest mints a fresh id and a slug like `guest-1` — the
 * same label unlock menus, vault lists, and account chrome use. Legacy
 * `Guest N` / `guest@guest` / fixed UUID are recognized only so old
 * directories still classify as guest, not so new sessions reuse them.
 */

import {
  type BoundaryValue,
  type OrganizationRole,
  isJsonObject,
  isString,
} from "@opensesame/os-domain";
import { kvDelete, kvGet, kvSet } from "./kv.js";

/** @deprecated Legacy singleton — detect only; never mint again. */
export const GUEST_PERSON_ID = "local_00000000-0000-4000-8000-000000000003";
/** @deprecated Legacy display name — detect only; never mint again. */
export const GUEST_PERSON_NAME = "guest@guest";

const GUEST_SESSION_KEY = "opensesame.guest.session-person";
/** Survives full navigations (GitHub App return); hydrated on cold boot. */
export const GUEST_ORDINAL_KEY = "opensesame.guest.ordinal.v1";
/** Durable copy of the tab's guest principal (OPFS); sessionStorage is a cache. */
export const GUEST_PERSON_KEY = "opensesame.guest.person.v1";

export type GuestSessionPerson = { id: string; name: string };

const GUEST_NAME_LEGACY_RE = /^Guest ([1-9]\d*)$/;
const GUEST_NAME_SLUG_RE = /^guest-[1-9]\d*$/;

function readStoredGuestPerson(raw: string): GuestSessionPerson | null {
  let parsed: BoundaryValue;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isJsonObject(parsed)) return null;
  const id = parsed.id;
  const name = parsed.name;
  if (!isString(id) || !isString(name)) return null;
  if (!id.startsWith("local_")) return null;
  if (!/^local_[0-9a-f-]{36}$/.test(id) && !id.startsWith("local_guest_")) {
    return null;
  }
  if (
    !GUEST_NAME_LEGACY_RE.test(name) &&
    !GUEST_NAME_SLUG_RE.test(name) &&
    !name.startsWith("guest@")
  ) {
    return null;
  }
  return { id, name: guestNameSlug(name) };
}

/** Canonical on-screen guest label — slug form, same everywhere. */
export function guestNameSlug(name: string): string {
  const legacy = GUEST_NAME_LEGACY_RE.exec(name.trim());
  if (legacy) return `guest-${legacy[1]}`;
  const trimmed = name.trim();
  if (GUEST_NAME_SLUG_RE.test(trimmed)) return trimmed;
  if (trimmed.toLowerCase() === "guest" || trimmed.startsWith("guest@")) {
    return "guest";
  }
  return trimmed;
}

/**
 * Label for the guest vault row and unlock chrome. Uses the tab's guest
 * slug when one exists; otherwise the generic `guest` road name.
 */
export function guestVaultLabel(): string {
  return readGuestSessionPerson()?.name ?? "guest";
}

function nextGuestOrdinal(): number {
  const raw = kvGet(GUEST_ORDINAL_KEY);
  let n = 0;
  if (isString(raw)) {
    const parsed = Number.parseInt(raw, 10);
    if (Number.isFinite(parsed) && parsed >= 0) n = parsed;
  }
  const next = n + 1;
  kvSet(GUEST_ORDINAL_KEY, String(next));
  return next;
}

function persistSessionPerson(person: GuestSessionPerson): void {
  const raw = JSON.stringify(person);
  kvSet(GUEST_PERSON_KEY, raw);
  try {
    sessionStorage.setItem(GUEST_SESSION_KEY, raw);
  } catch {
    /* private mode — OPFS/kv remains the surviving copy */
  }
}

/** Mint a new unclaimed guest principal (new id + `guest-N` slug). */
export function mintGuestSessionPerson(): GuestSessionPerson {
  clearGuestSessionPerson();
  const ordinal = nextGuestOrdinal();
  const person = {
    id: `local_${crypto.randomUUID()}`,
    name: `guest-${ordinal}`,
  };
  persistSessionPerson(person);
  return person;
}

/** Read the tab's guest principal without minting one. */
export function readGuestSessionPerson(): GuestSessionPerson | null {
  try {
    const cached = sessionStorage.getItem(GUEST_SESSION_KEY);
    if (cached) {
      const fromCache = readStoredGuestPerson(cached);
      if (fromCache) return fromCache;
    }
  } catch {
    /* fall through to durable copy */
  }
  const durable = kvGet(GUEST_PERSON_KEY);
  if (!isString(durable)) return null;
  const person = readStoredGuestPerson(durable);
  if (person) {
    try {
      sessionStorage.setItem(GUEST_SESSION_KEY, JSON.stringify(person));
    } catch {
      /* ignore */
    }
  }
  return person;
}

/**
 * Active guest for this tab. Resume keeps the same principal; call
 * `mintGuestSessionPerson` (via continue-as-guest) for a fresh one.
 */
export function guestSessionPerson(): GuestSessionPerson {
  const stored = readGuestSessionPerson();
  if (stored) return stored;
  return mintGuestSessionPerson();
}

export function clearGuestSessionPerson(): void {
  kvDelete(GUEST_PERSON_KEY);
  try {
    sessionStorage.removeItem(GUEST_SESSION_KEY);
  } catch {
    /* ignore */
  }
}

export function isGuestDisplayName(name: string): boolean {
  const trimmed = name.trim();
  return (
    trimmed === GUEST_PERSON_NAME ||
    trimmed.toLowerCase() === "guest" ||
    GUEST_NAME_LEGACY_RE.test(trimmed) ||
    GUEST_NAME_SLUG_RE.test(trimmed) ||
    trimmed.startsWith("guest@")
  );
}

type IdentityRef = {
  readonly id: string;
  readonly kind: string;
  readonly name: string;
  readonly enabled: boolean;
};

type MembershipRef = {
  readonly organizationId: string;
  readonly principalId: string;
  readonly role: OrganizationRole;
};

export function isGuestPersonEntry(entry: IdentityRef): boolean {
  return (
    entry.kind === "person" &&
    (entry.id === GUEST_PERSON_ID ||
      entry.id.startsWith("local_guest_") ||
      isGuestDisplayName(entry.name))
  );
}

/** Every guest person currently in a directory (never invents a singleton). */
export function guestPersonIds(
  entries: readonly IdentityRef[],
): readonly string[] {
  return entries.filter(isGuestPersonEntry).map((entry) => entry.id);
}

export function hasClaimedOperatorEntry(
  entries: readonly IdentityRef[],
  memberships: readonly MembershipRef[],
): boolean {
  return memberships.some(
    (row) =>
      (row.role === "owner" || row.role === "admin") &&
      entries.some(
        (entry) =>
          entry.id === row.principalId &&
          entry.kind === "person" &&
          entry.enabled &&
          !isGuestPersonEntry(entry),
      ),
  );
}

/** Refuse guest admin; refuse guest owner once a claimed operator exists. */
export function guestMembershipError(
  entries: readonly IdentityRef[],
  memberships: readonly MembershipRef[],
  person: IdentityRef,
  role: OrganizationRole,
): string | null {
  if (!isGuestPersonEntry(person)) return null;
  if (role === "admin") {
    return "Guest identities cannot be operators. Keep guest as Member and grant resources on Access.";
  }
  if (role === "owner" && hasClaimedOperatorEntry(entries, memberships)) {
    return "Guest identities cannot own the organization once an operator is assigned.";
  }
  return null;
}

/** When a claimed person becomes owner/admin, demote guest operators. */
export function demoteGuestOperators(
  entries: readonly IdentityRef[],
  memberships: readonly MembershipRef[],
  organizationId: string,
): MembershipRef[] {
  return memberships.map((row) => {
    if (row.organizationId !== organizationId) return row;
    const person = entries.find((entry) => entry.id === row.principalId);
    if (
      person &&
      isGuestPersonEntry(person) &&
      (row.role === "owner" || row.role === "admin")
    ) {
      return { ...row, role: "member" as const };
    }
    return row;
  });
}
