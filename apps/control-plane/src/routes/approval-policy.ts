import {
  type ApprovalPolicy,
  type ApprovalRiskClass,
  type JsonObject,
  type JsonValue,
  type NotificationChannelKind,
  approvalPolicyDigest,
  defaultApprovalPolicy,
  isString,
  normalizeApprovalPolicy,
  overlapCast,
} from "@opensesame/os-domain";

/**
 * The effective policy for one authorization request (ADR 0081).
 *
 * Pure, and deliberately so. The policy is resolved twice — once when an
 * activation is minted, once when a decision is settled — and the digest of
 * the second resolution is what the activation is checked against. If this
 * function read a clock, a database row or a random value, those two
 * resolutions could differ for reasons that have nothing to do with the
 * request, and every activation would be invalidated by noise. Because it is
 * a function of the request plus deployment configuration, the only way the
 * digest moves is that the request changed or the operator tightened the
 * rules — which is exactly when an activation *should* stop being spendable.
 *
 * The classifier reads `authorizationDetails` and nothing else. In
 * particular it does not read `bindingMessage`: that text is requester-
 * supplied, and a requester who can choose the policy their own request is
 * judged under has been handed the dial.
 */

/**
 * Verbs that observe. Everything else is treated as a change.
 *
 * A closed list of *readers* rather than an open list of writers, because the
 * failure directions are not symmetric: a writer this table forgets is judged
 * as a change (stricter than necessary, and merely annoying), while a reader
 * it wrongly admits would quietly downgrade the ceremony for a mutation.
 */
const READ_ONLY_VERBS = new Set([
  "read",
  "list",
  "get",
  "view",
  "describe",
  "head",
  "watch",
  "search",
  "query",
]);

/**
 * Operations whose abuse ends the account rather than costing it something.
 *
 * Recovery, authenticator binding, MFA disablement, impersonation and secret
 * export all share one property: performing them makes every later control
 * moot, so the ceremony for them cannot be the ordinary one.
 */
const CRITICAL_MARKERS = [
  "root",
  "recovery",
  "recover",
  "impersonat",
  "privilege_escalation",
  "escalate",
  "break_glass",
  "breakglass",
  "authenticator_binding",
  "bind_authenticator",
  "register_authenticator",
  "enroll_authenticator",
  "mfa_disable",
  "disable_mfa",
  "secret_export",
  "export_secret",
  "reveal_secret",
  "credential_export",
  "export_credential",
];

/** Operations that carry somebody else's authority, or the rules themselves. */
const HIGH_MARKERS = [
  "admin",
  "privileged",
  "superuser",
  "sudo",
  "owner",
  "policy",
  "grant",
  "delegate",
  "billing",
  "secret",
  "credential",
  "key",
  "token",
];

/** Fields of an RFC 9396 detail that can name an operation. */
const OPERATION_FIELDS = [
  "type",
  "actions",
  "privileges",
  "datatypes",
  "scope",
  "scopes",
  "permissions",
  "roles",
];

function collectStrings(value: JsonValue | undefined, into: string[]): void {
  if (isString(value)) {
    into.push(value.toLowerCase());
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectStrings(item, into);
  }
}

/** The action verbs a detail names, lower-cased and stripped to their last segment. */
function actionVerbs(detail: JsonObject): string[] {
  const raw: string[] = [];
  collectStrings(detail.actions, raw);
  collectStrings(detail.privileges, raw);
  return raw.map((action) => {
    const parts = action.split(/[.:_\-/]/);
    return parts.at(-1) ?? action;
  });
}

/** Every operation-naming string in the details, for marker matching. */
function operationSurface(details: JsonObject[]): string[] {
  const surface: string[] = [];
  for (const detail of details) {
    for (const field of OPERATION_FIELDS) {
      collectStrings(detail[field], surface);
    }
  }
  return surface;
}

export function classifyApprovalRisk(
  authorizationDetails: JsonObject[],
): ApprovalRiskClass {
  const surface = operationSurface(authorizationDetails);
  if (surface.some((s) => CRITICAL_MARKERS.some((m) => s.includes(m)))) {
    return "critical";
  }
  if (surface.some((s) => HIGH_MARKERS.some((m) => s.includes(m)))) {
    return "high";
  }
  const verbs = authorizationDetails.flatMap(actionVerbs);
  // No verbs at all is not "nothing to do": it is a request whose effect this
  // service cannot read, and an unreadable effect is not a read-only one.
  if (verbs.length === 0) return "moderate";
  return verbs.every((verb) => READ_ONLY_VERBS.has(verb)) ? "low" : "moderate";
}

/**
 * What the operator has opted in to, per deployment.
 *
 * Both lists start empty. Direct external settlement — a decision that lands
 * because a provider callback said so, with no OpenSesame ceremony in between
 * — is the single most dangerous thing in this subsystem, so it exists only
 * where a human wrote a channel down.
 */
export interface ApprovalPolicyDeployment {
  directApprovalChannels: readonly NotificationChannelKind[];
  directDenialChannels: readonly NotificationChannelKind[];
}

export interface ResolvedApprovalPolicy {
  policy: ApprovalPolicy;
  policyDigest: string;
  riskClass: ApprovalRiskClass;
}

/**
 * The policy this request is judged under, and its digest.
 *
 * The risk ladder decides which of the domain's default policies applies; the
 * deployment can only ever *narrow* what that default already allows, because
 * `normalizeApprovalPolicy` intersects the opted-in channels with the
 * policy's own allowed set and with what each channel's adapter can actually
 * demonstrate.
 *
 * The one place the ladder does more than pick a default: direct external
 * settlement is withdrawn as risk rises. Approval by callback is available
 * only for `low`, denial by callback up to `moderate` (refusing is the safe
 * direction, but it is not free — a forged denial is still a denial of
 * service), and neither above that. An operator who lists `slack` has said
 * "Slack may settle routine things", not "Slack may reset the root account".
 */
export function resolveApprovalPolicy(input: {
  authorizationDetails: JsonObject[];
  deployment: ApprovalPolicyDeployment;
}): ResolvedApprovalPolicy {
  const riskClass = classifyApprovalRisk(input.authorizationDetails);
  const base = defaultApprovalPolicy(riskClass);
  const directApprovalChannels =
    riskClass === "low" ? [...input.deployment.directApprovalChannels] : [];
  const directDenialChannels =
    riskClass === "low" || riskClass === "moderate"
      ? [...input.deployment.directDenialChannels]
      : [];
  const policy = normalizeApprovalPolicy({
    ...base,
    id: `policy:authorization-request:${riskClass}`,
    directApprovalChannels,
    directDenialChannels,
  });
  return {
    policy,
    // Digested from the normalized value, so the digest commits to what will
    // actually be enforced rather than to what was asked for.
    policyDigest: approvalPolicyDigest(overlapCast(policy)),
    riskClass,
  };
}
