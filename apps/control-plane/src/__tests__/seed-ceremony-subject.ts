/**
 * Seed an entitled ceremony row before POST /v1/interactions.
 * Create no longer auto-mints device/pairing/transaction subjects (F04/T-09).
 */

import {
  type BoundaryValue,
  isJsonObject,
  isString,
} from "@opensesame/os-domain";
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
    kind?: BoundaryValue;
    subject?: BoundaryValue;
  },
  fallbackSubjectId = "dev-session-77",
): void {
  const kind = isString(overrides.kind)
    ? overrides.kind
    : "device_authorization";
  let subjectKind = kind;
  let subjectId = fallbackSubjectId;
  if (isJsonObject(overrides.subject)) {
    const subject = overrides.subject;
    if (isString(subject.kind)) subjectKind = subject.kind;
    if (isString(subject.subjectId)) subjectId = subject.subjectId;
  }
  seedOwnedCeremony(cp, subjectKind, subjectId, ownerPrincipalId);
}
