/**
 * Apply a consumed approval onto the Identity-owned ceremony row.
 * Terminal rows are left alone so a racing second consume cannot throw.
 */

import {
  DomainError,
  type Interaction,
} from "@opensesame/os-domain";
import type { AppContext } from "../context.js";
import {
  authorizeTransaction,
  consumeOwnedDevice,
  pairSession,
} from "./ceremony-subjects.js";

function refuseExpired(expiresAt: Date, now: Date) {
  if (expiresAt.getTime() <= now.getTime()) {
    throw new DomainError("INVARIANT_VIOLATION", "subject expired");
  }
}

function applyDevice(ctx: AppContext, interaction: Interaction, now: Date) {
  const row = ctx.stores.ceremonySubjects.getDevice(
    interaction.subject.subjectId,
  );
  if (!row || !interaction.approverPrincipalId) return;
  if (row.session.state === "consumed") return;
  refuseExpired(row.session.expiresAt, now);
  ctx.stores.ceremonySubjects.putDevice(
    consumeOwnedDevice(row, interaction.approverPrincipalId, now),
  );
}

function applyPairing(ctx: AppContext, interaction: Interaction, now: Date) {
  const row = ctx.stores.ceremonySubjects.getPairing(
    interaction.subject.subjectId,
  );
  if (!row || !interaction.approverPrincipalId) return;
  if (row.state !== "pending") return;
  refuseExpired(row.expiresAt, now);
  ctx.stores.ceremonySubjects.putPairing(
    pairSession(row, interaction.approverPrincipalId, now),
  );
}

function applyTransaction(
  ctx: AppContext,
  interaction: Interaction,
  now: Date,
) {
  const row = ctx.stores.ceremonySubjects.getTransaction(
    interaction.subject.subjectId,
  );
  if (!row || !interaction.approverPrincipalId) return;
  if (row.state !== "pending") return;
  refuseExpired(row.expiresAt, now);
  ctx.stores.ceremonySubjects.putTransaction(
    authorizeTransaction(
      row,
      interaction.approverPrincipalId,
      now,
      interaction.resourceRef,
    ),
  );
}

export function applyHostCeremonySubject(
  ctx: AppContext,
  interaction: Interaction,
  now: Date,
): void {
  switch (interaction.kind) {
    case "device_authorization":
      applyDevice(ctx, interaction, now);
      return;
    case "pairing":
      applyPairing(ctx, interaction, now);
      return;
    case "transaction_authorization":
      applyTransaction(ctx, interaction, now);
      return;
    default:
      return;
  }
}
