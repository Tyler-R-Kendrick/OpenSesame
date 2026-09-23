import {
  type BoundaryValue,
  type JsonObject,
  type JsonValue,
  type MutableJsonObject,
  isBoolean,
  isJsonObject,
  isNumber,
  isString,
  isTypeofObject,
  overlapCast,
  readString,
} from "../json-boundary.js";
/**
 * Decoy/restricted external connections (UX-C / AT-093 / INV-28).
 * Default off. Only explicit safe low-authority connections.
 * Never forge production success or mutate production credentials.
 */

import type { PresentationClass } from "../access/context.js";

export type ConnectionAuthorityClass = "low" | "production" | "unknown";

export type SafeConnectionApproval = Readonly<{
  connectionRef: string;
  authorityClass: ConnectionAuthorityClass;
  /** Must be false — decoy must not change production credentials. */
  changesProductionCredentials: boolean;
  ownerExplicitApproval: true;
  approvedAt: string;
}>;

export type ConnectorDecision =
  | { ok: true; connectionRef: string }
  | {
      ok: false;
      code:
        | "decoy_externals_default_off"
        | "production_authority_forbidden"
        | "would_mutate_production_credentials"
        | "missing_explicit_approval"
        | "unsupported_forgery";
    };

export function decideConnectorAttach(input: {
  presentation: PresentationClass;
  connectionRef: string;
  authorityClass: ConnectionAuthorityClass;
  changesProductionCredentials: boolean;
  approval: SafeConnectionApproval | null;
  /** Callers must never request forged production success. */
  forgeProductionSuccess?: boolean;
}): ConnectorDecision {
  if (input.forgeProductionSuccess) {
    return { ok: false, code: "unsupported_forgery" };
  }

  if (input.presentation !== "decoy" && input.presentation !== "restricted") {
    if (input.changesProductionCredentials && input.presentation === "locked") {
      return { ok: false, code: "would_mutate_production_credentials" };
    }
    return { ok: true, connectionRef: input.connectionRef };
  }

  // Decoy / restricted: default off
  if (!input.approval) {
    return { ok: false, code: "decoy_externals_default_off" };
  }
  if (input.approval.connectionRef !== input.connectionRef) {
    return { ok: false, code: "missing_explicit_approval" };
  }
  if (!input.approval.ownerExplicitApproval) {
    return { ok: false, code: "missing_explicit_approval" };
  }
  if (
    input.authorityClass === "production" ||
    input.approval.authorityClass === "production"
  ) {
    return { ok: false, code: "production_authority_forbidden" };
  }
  if (
    input.changesProductionCredentials ||
    input.approval.changesProductionCredentials
  ) {
    return { ok: false, code: "would_mutate_production_credentials" };
  }
  if (input.authorityClass !== "low") {
    return { ok: false, code: "production_authority_forbidden" };
  }

  return { ok: true, connectionRef: input.connectionRef };
}

export function approveSafeLowAuthorityConnection(input: {
  connectionRef: string;
  at?: Date;
}): SafeConnectionApproval {
  return {
    connectionRef: input.connectionRef,
    authorityClass: "low",
    changesProductionCredentials: false,
    ownerExplicitApproval: true,
    approvedAt: (input.at ?? new Date()).toISOString(),
  };
}
