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
 * Canary enrollment registry — optional receiver, route revoke (CANARY-A/E).
 * No production session or key authority is admitted here.
 */

import {
  CANARY_BOUNDS,
  type CanaryEnrollment,
  type CanaryReceiver,
  CanarySchemaError,
  parseCanaryEnrollment,
} from "./schema.js";

export type CanaryRegistrySnapshot = Readonly<{
  enrollments: readonly CanaryEnrollment[];
}>;

export class CanaryRegistry {
  #byId = new Map<string, CanaryEnrollment>();

  enroll(input: BoundaryValue): CanaryEnrollment {
    const parsed = parseCanaryEnrollment(input);
    if (this.#byId.has(parsed.canaryId)) {
      throw new CanarySchemaError(
        "ambiguous_trigger",
        "canaryId already enrolled",
      );
    }
    this.#byId.set(parsed.canaryId, parsed);
    return parsed;
  }

  /**
   * Enroll honeytoken_open with an optional ALERT-shaped receiver.
   * Receiver may be null — detection remains local-only.
   */
  enrollHoneytoken(input: {
    canaryId: string;
    tokenFingerprint: string;
    receiver?: CanaryReceiver | null;
    enrolledAt?: string;
  }): CanaryEnrollment {
    return this.enroll({
      version: 1,
      canaryId: input.canaryId,
      kind: "honeytoken_open",
      tokenFingerprint: input.tokenFingerprint,
      receiver: input.receiver ?? null,
      enrolledAt: input.enrolledAt ?? new Date().toISOString(),
      routeRevoked: false,
    });
  }

  get(canaryId: string): CanaryEnrollment | undefined {
    return this.#byId.get(canaryId);
  }

  list(): readonly CanaryEnrollment[] {
    return [...this.#byId.values()];
  }

  /** Revoke the alert route for a canary; detection continues (CANARY-E). */
  revokeRoute(canaryId: string): CanaryEnrollment {
    const existing = this.#byId.get(canaryId);
    if (!existing) {
      throw new CanarySchemaError("unapproved_route", "unknown canaryId");
    }
    const next: CanaryEnrollment = { ...existing, routeRevoked: true };
    this.#byId.set(canaryId, next);
    return next;
  }

  /** Re-bind a receiver after revoke (owner re-consent path). */
  restoreRoute(canaryId: string, receiver: CanaryReceiver): CanaryEnrollment {
    const existing = this.#byId.get(canaryId);
    if (!existing) {
      throw new CanarySchemaError("unapproved_route", "unknown canaryId");
    }
    if (
      receiver.routeRef.length < 1 ||
      receiver.routeRef.length > CANARY_BOUNDS.routeRefMax
    ) {
      throw new CanarySchemaError("unapproved_route", "invalid routeRef");
    }
    const next: CanaryEnrollment = {
      ...existing,
      receiver,
      routeRevoked: false,
    };
    this.#byId.set(canaryId, next);
    return next;
  }

  snapshot(): CanaryRegistrySnapshot {
    return { enrollments: this.list() };
  }

  /** Disposable-fixture reset only. */
  clear(): void {
    this.#byId.clear();
  }
}
