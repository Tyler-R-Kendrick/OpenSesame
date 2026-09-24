import { randomUUID } from "node:crypto";
import { ConflictError, type UnitOfWork } from "@opensesame/database";
import type { ExternalIdentity } from "@opensesame/os-domain";
import type { AppContext } from "../context.js";

export async function linkProviderIdentityOnClaim(
  ctx: AppContext,
  registration: {
    kind: string;
    providerIssuer?: string;
    providerSubject?: string;
  },
  principal: { id: string },
  expectedEmail: string | undefined,
  now: Date,
  uow: import("@opensesame/database").UnitOfWork,
): Promise<void> {
  if (
    registration.kind !== "provider_assertion" ||
    !registration.providerIssuer ||
    !registration.providerSubject
  ) {
    return;
  }
  const linked = await ctx.repos.externalIdentities.findByTuple({
    kind: "auth_md",
    issuer: registration.providerIssuer,
    subject: registration.providerSubject,
  });
  if (linked && linked.principalId !== principal.id) {
    throw new ConflictError("provider identity already bound");
  }
  if (linked) return;
  const row: ExternalIdentity = {
    id: `xid_${randomUUID()}`,
    principalId: principal.id,
    kind: "auth_md",
    issuer: registration.providerIssuer,
    subject: registration.providerSubject,
    assurance: "verified",
    linkedAt: now,
    metadata: {},
  };
  if (expectedEmail) {
    row.emailNormalized = expectedEmail;
    row.emailVerified = true;
  }
  await ctx.repos.externalIdentities.create(row, uow);
}
