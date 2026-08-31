import {
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import { appendAuditEvent } from "@opensesame/audit";
import type { WebAuthnRpConfig } from "@opensesame/auth-upstream";
import { ConflictError, NotFoundError } from "@opensesame/database";
import {
  type ApprovalActivation,
  type ApprovalPath,
  type ApprovalPolicy,
  type ApprovalReceipt,
  type AuthenticationFacts,
  type AuthorizationRequest,
  DomainError,
  type IdentityEvidence,
  type NotificationChannelKind,
  type Principal,
  settle,
} from "@opensesame/os-domain";
import type { AppContext } from "../context.js";

/**
 * The pieces both settlement paths share (ADR 0081).
 *
 * There are two ways a decision reaches this service — an authenticated
 * in-app ceremony and an authenticated provider callback — and exactly one
 * way it may be recorded. Everything that decides *whether* a decision stands
 * lives in `evaluateApprovalCeremony`; everything that *writes it down* lives
 * here, so the two paths cannot drift into recording different things.
 */

/* ------------------------------------------------------------------ *
 * Opaque references
 * ------------------------------------------------------------------ */

/**
 * The handle a notification carries back.
 *
 * A raw request id in a Slack button is a request id in Slack's logs, in the
 * workspace's export, and in the hands of anyone who can post into the
 * channel. This is the same shape as `inboxRef`: the id under a MAC keyed by
 * the deployment pepper, so a reference cannot be minted for a request the
 * sender was not told about.
 *
 * The decision is inside the MAC. One message carries one reference per
 * button, and the reference minted for "deny" cannot be re-presented as
 * "approve" — the callback's own action id is checked against it.
 */
export function callbackTransactionRef(
  authReqId: string,
  decision: "approved" | "denied",
  pepper: string,
): string {
  const body = Buffer.from(`${authReqId} ${decision}`, "utf8").toString(
    "base64url",
  );
  const tag = createHmac("sha256", pepper)
    .update(`opensesame:callback-ref:v1 ${authReqId} ${decision}`)
    .digest("base64url")
    .slice(0, 32);
  return `oscb_${body}.${tag}`;
}

export function resolveCallbackTransactionRef(
  ref: string,
  pepper: string,
): { authReqId: string; decision: "approved" | "denied" } | null {
  if (!ref.startsWith("oscb_")) return null;
  const [body, tag] = ref.slice("oscb_".length).split(".");
  if (!body || !tag) return null;
  let decoded: string;
  try {
    decoded = Buffer.from(body, "base64url").toString("utf8");
  } catch {
    return null;
  }
  const [authReqId, decision] = decoded.split(" ");
  if (!authReqId || (decision !== "approved" && decision !== "denied")) {
    return null;
  }
  const expected = callbackTransactionRef(authReqId, decision, pepper);
  const a = Buffer.from(ref, "utf8");
  const b = Buffer.from(expected, "utf8");
  // Constant-time: the tag is a MAC, and a byte-at-a-time comparison an
  // attacker can time is a forgery oracle.
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  return { authReqId, decision };
}

/**
 * The relying party a WebAuthn ceremony is bound to.
 *
 * Derived from this deployment's own public URL and nothing the caller sent.
 * The rpID and origin are what make an assertion phishing-resistant at all —
 * a browser will not produce one for a look-alike host — so taking either
 * from a request header would hand that property away.
 */
export function webAuthnRpFromPublicUrl(publicUrl: string): WebAuthnRpConfig {
  let hostname = "localhost";
  try {
    hostname = new URL(publicUrl).hostname;
  } catch {
    /* keep the loopback default */
  }
  return { rpID: hostname, origin: publicUrl.replace(/\/$/, "") };
}

/* ------------------------------------------------------------------ *
 * Comparison values
 * ------------------------------------------------------------------ */

/**
 * The stored form of a comparison value.
 *
 * Keyed by the deployment pepper and bound to the request, so the stored
 * digest of `123456` for one request is not the stored digest of `123456` for
 * another. Without the pepper, six digits is a table of a million hashes
 * anyone holding the database could finish building over lunch.
 */
export function comparisonValueDigest(
  authReqId: string,
  value: string,
  pepper: string,
): string {
  return `v1:${createHmac("sha256", pepper)
    .update(`opensesame:comparison:v1 ${authReqId} ${value}`)
    .digest("hex")}`;
}

/* ------------------------------------------------------------------ *
 * Assurance facts
 * ------------------------------------------------------------------ */

/**
 * What a completed in-app activation proves.
 *
 * These facts are asserted by *this service* about a ceremony it ran, which
 * is the only reason they may claim phishing resistance and verifier name
 * binding: a WebAuthn assertion is bound to the relying-party id the browser
 * saw, so a look-alike origin produces no assertion at all. Nothing arriving
 * from a provider callback may ever be turned into this shape — those paths
 * get `channelAuthenticationCeiling` instead, which is a ceiling derived from
 * the adapter rather than a claim the provider made about itself.
 *
 * `factorCount: 2` records a credential enrolled with user verification
 * required: possession of the authenticator plus the biometric or PIN that
 * unlocked it. `deviceBinding` and `keyProtection` stay at their weakest
 * honest values, because without attestation this service cannot tell a
 * hardware key from a synced software one, and a policy that demands hardware
 * must fail rather than be told what it wants to hear.
 */
export function activationAuthenticationFacts(at: Date): AuthenticationFacts {
  return {
    authenticatedAt: at,
    userVerifiedAt: at,
    methods: ["webauthn:transaction"],
    factorCount: 2,
    userVerification: "local_user_verification",
    phishingResistant: true,
    verifierNameBound: true,
    deviceBinding: "software",
    keyProtection: "unknown",
    syncability: "unknown",
  };
}

/**
 * The identity evidence this service actually holds for a principal.
 *
 * A projection of the principal row, and nothing more. The identity plane has
 * no evidence store yet — the trust broker's `IdentityEvidence` is the shape
 * one will land in — so this is where the evaluator's `evidence` input comes
 * from, and it is written to under-claim: a provisional principal is
 * `self_attested`, a verified one `verified_account`, and a workload
 * principal reports `subjectKind: "workload"` so a policy written for humans
 * refuses it rather than quietly accepting a machine. A suspended or closed
 * principal's evidence is `revoked`, which the evaluator drops entirely — a
 * principal who may not act at all cannot approve anything either.
 */
export function principalEvidence(
  principal: Principal,
  issuer: string,
  authentication: AuthenticationFacts,
): IdentityEvidence[] {
  const proofing =
    principal.assurance === "enterprise_managed"
      ? "enterprise_asserted"
      : principal.assurance === "provisional" ||
          principal.assurance === "self_asserted"
        ? "self_attested"
        : "verified_account";
  return [
    {
      id: `evd_principal_${principal.id}`,
      principalId: principal.id,
      source: "self_attested",
      issuer,
      sourceArtifactDigest: createHash("sha256")
        .update(`opensesame:principal-evidence:v1 ${principal.id}`)
        .digest("hex"),
      claims: [],
      assurance: {
        subjectKind:
          principal.assurance === "workload_attested" ? "workload" : "human",
        identityProofing: proofing,
        authentication,
        federationIssuerTrust: "pre_registered",
      },
      acquiredAt: principal.createdAt,
      verifiedAt: principal.verifiedAt ?? principal.createdAt,
      // Provisional is a live state, not a lapsed one: a guest can hold
      // delegated authority, and the *proofing* above is what records how
      // little is known about them. Only suspension and closure revoke.
      state:
        principal.state === "suspended" || principal.state === "closed"
          ? "revoked"
          : "active",
      trustPolicyId: "principal-row",
      version: principal.version,
      metadata: {},
    },
  ];
}

/* ------------------------------------------------------------------ *
 * Recording a decision
 * ------------------------------------------------------------------ */

export interface RecordSettlementInput {
  ctx: AppContext;
  row: AuthorizationRequest;
  decision: "approved" | "denied";
  approverPrincipalId: string;
  path: ApprovalPath;
  channelKind: NotificationChannelKind;
  policy: ApprovalPolicy;
  policyDigest: string;
  transactionDigest: string;
  activation?: ApprovalActivation;
  bindingId?: string;
  comparisonRequired: boolean;
  comparisonSatisfied: boolean;
  required: string[];
  achieved: string[];
  evidenceIds: string[];
  callbackDigest?: string;
  correlationId?: string;
  now: Date;
  /**
   * Whether to publish the decision on the outbox.
   *
   * On for ordinary settlements: the requester is waiting, and registered
   * webhooks are how they hear. Off for "I did not recognize this", where the
   * person has just said the prompt was not theirs and the last thing to do
   * is generate more traffic about it.
   */
  publish: boolean;
}

export type SettlementOutcome =
  | { ok: true; request: AuthorizationRequest; receipt: ApprovalReceipt }
  | { ok: false; reason: "activation_conflict" | "conflict" | "not_found" }
  | { ok: false; reason: "domain"; error: DomainError };

/**
 * Spend the activation, then move the request, then write the receipt.
 *
 * The order is the security property. `consume` is a compare-and-set on a
 * persisted row: exactly one caller gets the activation and everyone else
 * gets `null` and refuses. Doing it *before* the request moves means a lost
 * race settles nothing; doing it after would let two concurrent settlements
 * both pass their checks and both write. If the request update then loses its
 * own version check, the activation stays spent — a burned activation and an
 * unsettled request is the safe end of that race, and the approver can start
 * another ceremony.
 */
export async function recordSettlement(
  input: RecordSettlementInput,
): Promise<SettlementOutcome> {
  const { ctx, row, now } = input;
  if (input.activation) {
    const consumed = await ctx.repos.approvalActivations.consume(
      input.activation.id,
      now,
    );
    if (!consumed) return { ok: false, reason: "activation_conflict" };
  }

  let saved: AuthorizationRequest;
  try {
    const settled = settle(row, {
      status: input.decision,
      decidedByPrincipalId: input.approverPrincipalId,
      decidedByKind: "human",
      now,
    });
    saved = await ctx.repos.authorizationRequests.updateWithVersion(
      row.id,
      row.version,
      {
        status: settled.status,
        ...(settled.decidedAt ? { decidedAt: settled.decidedAt } : undefined),
        ...(settled.decidedByPrincipalId
          ? { decidedByPrincipalId: settled.decidedByPrincipalId }
          : undefined),
        ...(settled.decidedByKind
          ? { decidedByKind: settled.decidedByKind }
          : undefined),
      },
    );
  } catch (error) {
    if (error instanceof DomainError) {
      return { ok: false, reason: "domain", error };
    }
    if (error instanceof ConflictError)
      return { ok: false, reason: "conflict" };
    if (error instanceof NotFoundError) {
      return { ok: false, reason: "not_found" };
    }
    throw error;
  }

  if (input.comparisonSatisfied) {
    await ctx.repos.comparisonChallenges.markSatisfied(row.id, now);
  }

  const receipt: ApprovalReceipt = {
    id: `arcp_${randomBytes(12).toString("base64url")}`,
    authReqId: saved.id,
    principalId: input.approverPrincipalId,
    decision: input.decision,
    decidedByKind: "human",
    path: input.path,
    channelKind: input.channelKind,
    ...(input.bindingId ? { bindingId: input.bindingId } : undefined),
    requestDigest: saved.requestDigest,
    transactionDigest: input.transactionDigest,
    policyDigest: input.policyDigest,
    requiredAssurance: input.required,
    achievedAssurance: input.achieved,
    evidenceIds: input.evidenceIds,
    ...(input.activation ? { activationId: input.activation.id } : undefined),
    comparisonRequired: input.comparisonRequired,
    comparisonSatisfied: input.comparisonSatisfied,
    ...(input.callbackDigest
      ? { callbackDigest: input.callbackDigest }
      : undefined),
    decidedAt: now,
    receiptVersion: 1,
  };
  try {
    await ctx.repos.approvalReceipts.create(receipt);
  } catch (error) {
    // One receipt per request, enforced by the store. The request has already
    // moved and the activation is already spent, so a duplicate here means
    // somebody recorded this settlement first — the decision stands, and
    // failing the whole call would tell the caller otherwise.
    if (!(error instanceof ConflictError)) throw error;
  }

  await appendAuditEvent(ctx.repos.auditEvents, {
    eventType: "authority.invocation.completed",
    principalId: input.approverPrincipalId,
    actorType: "human",
    outcome: input.decision === "approved" ? "succeeded" : "denied",
    ...(input.correlationId
      ? { correlationId: input.correlationId }
      : undefined),
    // Digest-shaped keys only. No comparison value, no provider payload, no
    // display label: this row outlives every one of them.
    metadata: {
      authReqId: saved.id,
      requestDigest: saved.requestDigest,
      transactionDigest: input.transactionDigest,
      policyDigest: input.policyDigest,
      path: input.path,
      channelKind: input.channelKind,
      decidedByKind: "human",
      comparisonRequired: input.comparisonRequired,
      comparisonSatisfied: input.comparisonSatisfied,
      ...(input.callbackDigest
        ? { callbackDigest: input.callbackDigest }
        : undefined),
      ...(saved.connectionId
        ? { connectionId: saved.connectionId }
        : undefined),
    },
  });

  if (input.publish) {
    await ctx.repos.outbox.append({
      id: randomBytes(16).toString("hex"),
      aggregateType: "authorization_request",
      aggregateId: saved.id,
      eventType: "authority.invocation.completed",
      payload: {
        principalId: saved.principalId,
        authReqId: saved.id,
        requestDigest: saved.requestDigest,
        status: saved.status,
        decidedByKind: saved.decidedByKind ?? "human",
      },
    });
  }

  return { ok: true, request: saved, receipt };
}
