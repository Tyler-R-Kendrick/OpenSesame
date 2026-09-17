/**
 * Seed an entitled ceremony row before POST /v1/interactions.
 * Create no longer auto-mints device/pairing/transaction subjects (F04/T-09).
 */

import { seedCeremonySubject } from "../services/ceremony-subjects.js";

type Plane = {
  ctx: {
    clock: () => Date;
    stores: {
      ceremonySubjects: Parameters<typeof seedCeremonySubject>[0];
    };
  };
};

export function seedOwnedCeremony(
  cp: Plane,
  kind: string,
  subjectId: string,
  ownerPrincipalId: string,
): void {
  if (
    kind !== "device_authorization" &&
    kind !== "pairing" &&
    kind !== "transaction_authorization"
  ) {
    return;
  }
  seedCeremonySubject(
    cp.ctx.stores.ceremonySubjects,
    kind,
    subjectId,
    ownerPrincipalId,
    cp.ctx.clock(),
  );
}

export function seedRaiseSubject(
  cp: Plane,
  ownerPrincipalId: string,
  overrides: {
    kind?: unknown;
    subject?: unknown;
  },
  fallbackSubjectId = "dev-session-77",
): void {
  const kind =
    typeof overrides.kind === "string"
      ? overrides.kind
      : "device_authorization";
  let subjectKind = kind;
  let subjectId = fallbackSubjectId;
  if (overrides.subject && typeof overrides.subject === "object") {
    const subject = overrides.subject as {
      kind?: unknown;
      subjectId?: unknown;
    };
    if (typeof subject.kind === "string") subjectKind = subject.kind;
    if (typeof subject.subjectId === "string") subjectId = subject.subjectId;
  }
  seedOwnedCeremony(cp, subjectKind, subjectId, ownerPrincipalId);
}
