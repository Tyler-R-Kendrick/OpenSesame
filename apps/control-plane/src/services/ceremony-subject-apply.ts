/**
 * Apply a consumed approval onto the Identity-owned ceremony row.
 * Terminal rows are left alone so a racing second consume cannot throw.
 */

import type { Interaction, InteractionKind } from "@opensesame/os-domain";
import type { AppContext } from "../context.js";
import {
  authorizeTransaction,
  consumeOwnedDevice,
  pairSession,
} from "./ceremony-subjects.js";

function applyDevice(ctx: AppContext, interaction: Interaction, now: Date) {
  const row = ctx.stores.ceremonySubjects.getDevice(
    interaction.subject.subjectId,
  );
  if (!row || !interaction.approverPrincipalId) return;
  if (row.session.state === "consumed") return;
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
  ctx.stores.ceremonySubjects.putTransaction(
    authorizeTransaction(
      row,
      interaction.approverPrincipalId,
      now,
      interaction.resourceRef,
    ),
  );
}

const APPLIERS: Partial<
  Record<
    InteractionKind,
    (ctx: AppContext, interaction: Interaction, now: Date) => void
  >
> = {
  device_authorization: applyDevice,
  pairing: applyPairing,
  transaction_authorization: applyTransaction,
};

function noop() {}

export function applyHostCeremonySubject(
  ctx: AppContext,
  interaction: Interaction,
  now: Date,
): void {
  (APPLIERS[interaction.kind] ?? noop)(ctx, interaction, now);
}
