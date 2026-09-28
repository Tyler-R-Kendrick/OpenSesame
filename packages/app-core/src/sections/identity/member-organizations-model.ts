/**
 * View-model for the signed-in member's organizations (ADR 0105, ADR 0133
 * §8): which keys a local session's row may draw, and the sentences its
 * marks carry. No React, no DOM.
 *
 * The keys mirror `changeLocalOrganizationMembership`'s own rule so a person
 * is not offered a change the library would refuse; the library still
 * decides, inside the session fence, on every press.
 */
import type { OrganizationRole } from "@opensesame/os-domain";
import { LocalDirectoryError } from "../../lib/local-directory-types.js";
import { isGuestPersonEntry } from "../../lib/local-guest.js";
import {
  type LocalOrganizationMember,
  changeLocalOrganizationMembership,
  listLocalOrganizations,
  readLocalOrganization,
} from "../../lib/local-organizations.js";
import type { LocalSession } from "../../lib/local-sessions.js";

export type MemberRowKeys = Readonly<{
  /** Roles the session may set on this row; empty draws no role select. */
  roles: readonly OrganizationRole[];
  /** Whether the session may remove this row. */
  remove: boolean;
}>;

const NO_KEYS: MemberRowKeys = { roles: [], remove: false };
const ALL_ROLES: readonly OrganizationRole[] = ["member", "admin", "owner"];

/**
 * Owner: every role on every person, removal of anyone (the directory keeps
 * the last owner). Admin: removal of ordinary members only. Member, and any
 * agent-key session: nothing. Agents and guests are only ever members, so an
 * owner gets no role select for them.
 */
export function memberRowKeys(
  authentication: LocalSession["authentication"],
  sessionRole: OrganizationRole,
  member: Pick<LocalOrganizationMember, "principalId" | "role" | "kind"> & {
    name: string;
  },
): MemberRowKeys {
  if (authentication !== "passkey") return NO_KEYS;
  if (sessionRole === "owner") {
    const onlyMember =
      member.kind !== "person" ||
      isGuestPersonEntry({
        id: member.principalId,
        kind: member.kind,
        name: member.name,
        // Guest status reads the id and name only; enablement is the
        // directory's own check on commit.
        enabled: true,
      });
    return { roles: onlyMember ? [] : ALL_ROLES, remove: true };
  }
  if (sessionRole === "admin" && member.role === "member")
    return { roles: [], remove: true };
  return NO_KEYS;
}

const REFUSAL_FALLBACK =
  "The organization change did not complete. Unlock the vault and retry.";

/** What a session-enforced call came to: its value, or the sentence it was refused with. */
export type OrganizationOutcome<T> =
  | Readonly<{ ok: true; value: T }>
  | Readonly<{ ok: false; refusal: string }>;

/**
 * Settle one session-enforced call. A refusal carries the library's own
 * sentence (`LocalDirectoryError`); anything else gets a safe fallback, so
 * no storage detail reaches a mark.
 */
export async function settleOrganizationCall<T>(
  work: Promise<T>,
): Promise<OrganizationOutcome<T>> {
  try {
    return { ok: true, value: await work };
  } catch (failure) {
    return {
      ok: false,
      refusal:
        failure instanceof LocalDirectoryError
          ? failure.message
          : REFUSAL_FALLBACK,
    };
  }
}

export function listMemberOrganizations(tomb: string, session: LocalSession) {
  return settleOrganizationCall(listLocalOrganizations(tomb, session));
}

export function readMemberOrganization(
  tomb: string,
  session: LocalSession,
  organizationId: string,
) {
  return settleOrganizationCall(
    readLocalOrganization(tomb, session, organizationId),
  );
}

export function changeMemberOrganization(
  tomb: string,
  session: LocalSession,
  organizationId: string,
  principalId: string,
  role: OrganizationRole | null,
) {
  return settleOrganizationCall(
    changeLocalOrganizationMembership(
      tomb,
      session,
      organizationId,
      principalId,
      role,
    ),
  );
}

/** A list's one mark: its tone and the sentence it carries. */
export type MemberMarkStatus = Readonly<{
  tone: "ok" | "err" | "idle";
  label: string;
}>;

/** Status of the session's organization list; `count` is null while loading. */
export function organizationListStatus(
  count: number | null,
  refusal: string,
): MemberMarkStatus {
  if (refusal) return { tone: "err", label: refusal };
  if (count === null) return { tone: "idle", label: "Loading organizations…" };
  if (count === 0)
    return { tone: "idle", label: "Not a member of any organization." };
  return {
    tone: "ok",
    label:
      count === 1
        ? "Member of 1 organization."
        : `Member of ${count} organizations.`,
  };
}

/** Status of one open organization's member list. */
export function memberListStatus(
  count: number | null,
  refusal: string,
  busy: boolean,
): MemberMarkStatus {
  if (refusal) return { tone: "err", label: refusal };
  if (busy) return { tone: "idle", label: "Complete the membership change…" };
  if (count === null) return { tone: "idle", label: "Loading members…" };
  return {
    tone: "ok",
    label: count === 1 ? "1 member." : `${count} members.`,
  };
}

/**
 * Every membership edit advances the directory revision, and ADR 0104 binds
 * each local session to the revision it was issued at — so the session that
 * made the change ends with it. The session view shows this only once its
 * own revalidation has found no session.
 */
export const MEMBERSHIP_CHANGED_SIGN_IN_AGAIN =
  "Membership changed. Local sessions ended; sign in again.";
