/**
 * Owner consent + destructive acknowledgement digests for enrollment.
 * Digests bind to reviewed scope text — never to cleartext codes.
 */

export type ConsentPayload = Readonly<{
  ownerPrincipalRef: string;
  policyId: string;
  policyRevision: number;
  profileIds: readonly string[];
  exposureDigestMaterial: string;
  acknowledgedAt: string;
}>;

export type DestructiveAckPayload = Readonly<{
  removalResourceRefs: readonly string[];
  acceptUnrecoverability: boolean;
  holdDisclosureAck: boolean;
  acknowledgedAt: string;
}>;

async function sha256Hex(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export async function digestOwnerConsent(
  payload: ConsentPayload,
): Promise<string> {
  const canonical = JSON.stringify({
    ownerPrincipalRef: payload.ownerPrincipalRef,
    policyId: payload.policyId,
    policyRevision: payload.policyRevision,
    profileIds: [...payload.profileIds].sort(),
    exposureDigestMaterial: payload.exposureDigestMaterial,
    acknowledgedAt: payload.acknowledgedAt,
  });
  return sha256Hex(canonical);
}

export async function digestDestructiveAck(
  payload: DestructiveAckPayload,
): Promise<string | null> {
  if (payload.removalResourceRefs.length === 0 && !payload.holdDisclosureAck) {
    return null;
  }
  if (
    payload.removalResourceRefs.length > 0 &&
    !payload.acceptUnrecoverability
  ) {
    throw new Error("destructive_ack_required");
  }
  const canonical = JSON.stringify({
    removalResourceRefs: [...payload.removalResourceRefs].sort(),
    acceptUnrecoverability: payload.acceptUnrecoverability,
    holdDisclosureAck: payload.holdDisclosureAck,
    acknowledgedAt: payload.acknowledgedAt,
  });
  return sha256Hex(canonical);
}

export type RecipientRole =
  | "alert_recipient"
  | "hold_custodian"
  | "recovery_approver"
  | "key_custodian"
  | "affected_owner";

export type RecipientPlan = Readonly<{
  role: RecipientRole;
  label: string;
  ref: string;
  /** Honest capability boundary — never implies unlock/authority. */
  cannot: readonly string[];
}>;

export const RECIPIENT_ROLE_BOUNDARIES = {
  alert_recipient: [
    "Cannot unlock vaults",
    "Cannot approve recovery",
    "Cannot delete by virtue of the alert",
    "Notification acknowledgement never unlocks",
  ],
  hold_custodian: [
    "Contributes to clearing an independent hold only",
    "Not equivalent to key custody unless also a key custodian",
  ],
  recovery_approver: [
    "Signs request-digest-bound approvals only",
    "Does not imply possession of recovery shares",
  ],
  key_custodian: [
    "Holds recovery shares / wrapping secret",
    "Shares must not live only inside a removed compartment",
  ],
  affected_owner: [
    "Arms, disarms, and authorizes scope",
    "Scope expansion requires each affected owner",
  ],
} as const satisfies Record<RecipientRole, readonly string[]>;

export function planRecipient(
  role: RecipientRole,
  ref: string,
  label: string,
): RecipientPlan {
  return {
    role,
    ref,
    label,
    cannot: RECIPIENT_ROLE_BOUNDARIES[role],
  };
}

export function validateRecipientSetup(
  plans: readonly RecipientPlan[],
  needs: { recipient: boolean; custodian: boolean },
): { ok: true } | { ok: false; reason: string } {
  if (needs.recipient) {
    const has = plans.some((p) => p.role === "alert_recipient");
    if (!has) return { ok: false, reason: "alert_recipient_required" };
  }
  if (needs.custodian) {
    const has = plans.some(
      (p) => p.role === "hold_custodian" || p.role === "key_custodian",
    );
    if (!has) return { ok: false, reason: "custodian_required" };
  }
  return { ok: true };
}
