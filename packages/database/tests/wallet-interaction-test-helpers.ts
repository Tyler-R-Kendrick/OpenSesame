import { randomBytes, randomUUID } from "node:crypto";
import type { Interaction } from "@opensesame/os-domain";
import {
  type ExecutionReservationRepository,
  type InteractionProofAttempt,
  type InteractionProofAttemptRepository,
  MemoryRepositories,
  type Repositories,
  type WalletRegistration,
  type WalletRegistrationRepository,
} from "../src/index.js";
import { makePrincipal } from "./factories.js";
import type { PgTestContext } from "./pg-harness-full.js";

export function makeInteraction(
  overrides: Partial<Interaction> = {},
): Interaction {
  const now = new Date("2026-03-04T05:00:00.000Z");
  const kind = overrides.kind ?? "authorization_request";
  return {
    id: `int_${randomBytes(18).toString("base64url")}`,
    kind,
    status: "pending",
    subject: { kind, subjectId: `sub_${randomUUID()}` },
    createdAt: now,
    expiresAt: new Date(now.getTime() + 300_000),
    authorizationDetails: [],
    version: 1,
    ...overrides,
  };
}

export function makeProofAttempt(
  interactionId: string,
  overrides: Partial<InteractionProofAttempt> = {},
): InteractionProofAttempt {
  return {
    id: `ipa_${randomBytes(12).toString("base64url")}`,
    interactionId,
    mechanism: "webauthn",
    outcome: "rejected_verification",
    proofInputDigest: Uint8Array.from(randomBytes(32)),
    boundDigest: "sha256:0f1e2d3c",
    expectedDigest: "sha256:0f1e2d3c",
    createdAt: new Date("2026-03-04T05:01:00.000Z"),
    ...overrides,
  };
}

export function makeRegistration(
  overrides: Partial<WalletRegistration> = {},
): WalletRegistration {
  const now = new Date("2026-03-04T05:00:00.000Z");
  const subjectKind = overrides.subjectKind ?? "authorization_request";
  return {
    id: `wreg_${randomBytes(12).toString("base64url")}`,
    provider: "google_wallet",
    status: "active",
    subjectKind,
    subjectId: `sub_${randomUUID()}`,
    providerObjectRef: `obj_${randomUUID()}`,
    createdAt: now,
    updatedAt: now,
    version: 1,
    ...overrides,
  };
}

export interface Fixture {
  repos: Repositories;
  newInteraction: (overrides?: Partial<Interaction>) => Promise<Interaction>;
  approverId: string;
}

/**
 * The text of a refused write, cause chain included. Drizzle re-throws with
 * "Failed query" and hangs the driver's error — and the constraint name — off
 * `cause`, so the part that says which invariant refused is a level down.
 */
export async function refusalText<Written>(
  run: () => PromiseLike<Written>,
): Promise<string> {
  try {
    await run();
  } catch (err) {
    const parts: string[] = [];
    let cursor: unknown = err;
    while (cursor instanceof Error) {
      parts.push(cursor.message);
      cursor = cursor.cause;
    }
    return parts.length > 0 ? parts.join("\n") : String(cursor);
  }
  throw new Error("expected the write to be refused");
}
