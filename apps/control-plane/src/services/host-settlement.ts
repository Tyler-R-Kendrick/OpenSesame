/**
 * Identity-plane observation of a consumed interaction (F05, X-05).
 *
 * The Rust Host is optional. This store records the Identity-owned ceremony,
 * claim, or authorization row consume actually mutated. Host HTTP, when a
 * deployment opts in, is extra dispatch and must not un-succeed this record.
 */

import type { Interaction, InteractionKind } from "@opensesame/os-domain";
import type { CeremonySubjectStore } from "./ceremony-subjects.js";

export type HostSettlementOutcome = "succeeded" | "outcome_unknown";

export interface HostEffect {
  readonly kind: InteractionKind;
  readonly subjectId: string;
  readonly outcome: HostSettlementOutcome;
  readonly eventType: string;
  readonly requestDigest?: string;
  readonly sessionId?: string;
  readonly grantId?: string;
}

export interface SettledSubjectFacts {
  readonly claimCompleted?: boolean;
  readonly claimId?: string;
  readonly authzApproved?: boolean;
}

export interface HostSettlementStore {
  record(effect: HostEffect): void;
  get(kind: InteractionKind, subjectId: string): HostEffect | undefined;
}

function keyOf(kind: InteractionKind, subjectId: string): string {
  return `${kind}:${subjectId}`;
}

export function createMemoryHostSettlementStore(): HostSettlementStore {
  const rows = new Map<string, HostEffect>();
  return {
    record: (effect) => {
      rows.set(keyOf(effect.kind, effect.subjectId), effect);
    },
    get: (kind, subjectId) => rows.get(keyOf(kind, subjectId)),
  };
}

const UNKNOWN: Pick<HostEffect, "outcome"> = { outcome: "outcome_unknown" };

function observeDevice(ceremony: CeremonySubjectStore, subjectId: string) {
  const row = ceremony.getDevice(subjectId);
  if (row?.session.state !== "consumed") return UNKNOWN;
  return { outcome: "succeeded" as const, sessionId: row.session.id };
}

function observePairing(ceremony: CeremonySubjectStore, subjectId: string) {
  const row = ceremony.getPairing(subjectId);
  if (row?.state !== "paired") return UNKNOWN;
  return { outcome: "succeeded" as const, sessionId: row.id };
}

function observeTransaction(ceremony: CeremonySubjectStore, subjectId: string) {
  const row = ceremony.getTransaction(subjectId);
  if (row?.state !== "authorized") return UNKNOWN;
  return { outcome: "succeeded" as const };
}

function observeClaim(facts: SettledSubjectFacts) {
  if (!facts.claimCompleted) return UNKNOWN;
  return { outcome: "succeeded" as const };
}

function observeGrant(facts: SettledSubjectFacts) {
  if (!facts.claimCompleted || !facts.claimId) return UNKNOWN;
  return { outcome: "succeeded" as const, grantId: facts.claimId };
}

function observeAuthz(facts: SettledSubjectFacts) {
  if (!facts.authzApproved) return UNKNOWN;
  return { outcome: "succeeded" as const };
}

function observeSettledSubject(
  ceremony: CeremonySubjectStore,
  interaction: Interaction,
  facts: SettledSubjectFacts,
): Pick<HostEffect, "outcome" | "sessionId" | "grantId"> {
  const subjectId = interaction.subject.subjectId;
  switch (interaction.kind) {
    case "device_authorization":
      return observeDevice(ceremony, subjectId);
    case "pairing":
      return observePairing(ceremony, subjectId);
    case "transaction_authorization":
      return observeTransaction(ceremony, subjectId);
    case "claim":
      return observeClaim(facts);
    case "grant_claim":
      return observeGrant(facts);
    case "authorization_request":
      return observeAuthz(facts);
    default:
      return UNKNOWN;
  }
}

export function settleHostSubject(
  store: HostSettlementStore,
  ceremony: CeremonySubjectStore,
  interaction: Interaction,
  eventType: string,
  facts: SettledSubjectFacts = {},
): HostEffect {
  const observed = observeSettledSubject(ceremony, interaction, facts);
  const effect: HostEffect = {
    kind: interaction.kind,
    subjectId: interaction.subject.subjectId,
    outcome: observed.outcome,
    eventType,
    ...(interaction.requestDigest
      ? { requestDigest: interaction.requestDigest }
      : {}),
    ...(observed.sessionId ? { sessionId: observed.sessionId } : {}),
    ...(observed.grantId ? { grantId: observed.grantId } : {}),
  };
  store.record(effect);
  return effect;
}
