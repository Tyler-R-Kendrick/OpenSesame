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
 * Alert route enrollment, consent, revocation, readiness (ALERT-D).
 * No first-activation permission prompt — routes must be ready at enroll.
 */

/** Mirrors DuressAssuranceLevel — local to avoid contracts churn in ALERT. */
export type AlertRouteReadiness =
  | "unavailable"
  | "unsupported"
  | "configured"
  | "verified_ready";

export type AlertRouteRecord = Readonly<{
  routeRef: string;
  origin: string;
  recipientPrincipalRef: string;
  templateRef: string;
  consentedAt: string;
  testPassedAt: string | null;
  revokedAt: string | null;
  expiresAt: string | null;
  readiness: AlertRouteReadiness;
}>;

export type RouteRegistrySnapshot = Readonly<{
  routes: readonly AlertRouteRecord[];
}>;

const BLOCKED_HOSTS = new Set(["metadata.google.internal", "169.254.169.254"]);

export function assertSafeAlertOrigin(origin: string): void {
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    throw new Error("unapproved_route");
  }
  if (
    url.protocol !== "https:" &&
    url.hostname !== "localhost" &&
    url.hostname !== "127.0.0.1"
  ) {
    throw new Error("unapproved_route");
  }
  if (url.username || url.password) throw new Error("unapproved_route");
  if (BLOCKED_HOSTS.has(url.hostname)) throw new Error("unapproved_route");
}

export class AlertRouteRegistry {
  #routes = new Map<string, AlertRouteRecord>();

  enroll(input: {
    routeRef: string;
    origin: string;
    recipientPrincipalRef: string;
    templateRef: string;
    consentedAt: string;
    expiresAt?: string | null;
  }): AlertRouteRecord {
    assertSafeAlertOrigin(input.origin);
    if (this.#routes.has(input.routeRef)) {
      throw new Error("ambiguous_trigger: route already enrolled");
    }
    const rec: AlertRouteRecord = {
      routeRef: input.routeRef,
      origin: input.origin,
      recipientPrincipalRef: input.recipientPrincipalRef,
      templateRef: input.templateRef,
      consentedAt: input.consentedAt,
      testPassedAt: null,
      revokedAt: null,
      expiresAt: input.expiresAt ?? null,
      readiness: "configured",
    };
    this.#routes.set(input.routeRef, rec);
    return rec;
  }

  /** Recipient consent + test must complete before arming (offline readiness). */
  markTestPassed(routeRef: string, at: string): AlertRouteRecord {
    const rec = this.#require(routeRef);
    if (rec.revokedAt) throw new Error("unapproved_route: revoked");
    if (rec.expiresAt && Date.parse(rec.expiresAt) < Date.parse(at)) {
      throw new Error("unapproved_route: expired");
    }
    const next: AlertRouteRecord = {
      ...rec,
      testPassedAt: at,
      readiness: "verified_ready",
    };
    this.#routes.set(routeRef, next);
    return next;
  }

  revoke(routeRef: string, at: string): AlertRouteRecord {
    const rec = this.#require(routeRef);
    const next: AlertRouteRecord = {
      ...rec,
      revokedAt: at,
      readiness: "unavailable",
    };
    this.#routes.set(routeRef, next);
    return next;
  }

  /**
   * Fail closed if route is not verified_ready at use boundary.
   * Callers must invoke this at enroll/arm — never prompt at first activation.
   */
  assertReady(routeRef: string, now = Date.now()): AlertRouteRecord {
    const rec = this.#require(routeRef);
    if (rec.revokedAt) throw new Error("unapproved_route: revoked");
    if (rec.expiresAt && Date.parse(rec.expiresAt) < now) {
      throw new Error("unapproved_route: expired");
    }
    if (rec.readiness !== "verified_ready" || !rec.testPassedAt) {
      throw new Error("unapproved_route: not verified_ready");
    }
    return rec;
  }

  get(routeRef: string): AlertRouteRecord | undefined {
    return this.#routes.get(routeRef);
  }

  snapshot(): RouteRegistrySnapshot {
    return { routes: [...this.#routes.values()] };
  }

  #require(routeRef: string): AlertRouteRecord {
    const rec = this.#routes.get(routeRef);
    if (!rec) throw new Error("unapproved_route: unknown");
    return rec;
  }
}
