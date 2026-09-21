import { describe, expect, it } from "vitest";
import { generateAgeKeyPair } from "../../../age-keys.js";
import { mintRootKeyHandle } from "../adapter.js";
import {
  ageIdentityIsIndependentRecovery,
  assertAgeRecoveryIndependent,
} from "../age-bootstrap.js";
import { ProtectionError } from "../errors.js";
import { ROOT_KEY_BYTES } from "../limits.js";
import type { ProtectionContext } from "../types.js";
import {
  ageRecipientCanSatisfyLastVerifiedGuard,
  createAgeRecipientAdapter,
  publishUntestedAgeRecipient,
} from "./age-recipient.js";

function context(protectorId: string): ProtectionContext {
  return {
    vaultId: "vault_test",
    rootKeyId: "root_test",
    rootEpoch: 1,
    protectorId,
    purpose: "human-vault-root",
  };
}

describe("age-recipient protector", () => {
  it("enrolls with independent open proof and reopens the exact root (KP-09)", async () => {
    const pair = await generateAgeKeyPair();
    const rootKey = crypto.getRandomValues(new Uint8Array(ROOT_KEY_BYTES));
    const ctx = context("age_protector_1");
    const adapter = createAgeRecipientAdapter({
      recipients: [pair.recipient],
      resolveIdentity: async () => pair.identity,
      custody: "external",
      sessionGeneration: 1,
    });
    const pending = await adapter.enroll({
      operationId: "op1",
      sessionGeneration: 1,
      context: ctx,
      rootHandle: mintRootKeyHandle(ctx, rootKey),
    });
    expect(pending.record.kind).toBe("age-recipient");
    if (pending.record.kind !== "age-recipient") return;
    expect(pending.record.proofStatus).toBe("verified");
    expect(pending.proof.ok).toBe(true);
    expect(ageRecipientCanSatisfyLastVerifiedGuard(pending.record)).toBe(true);

    const opened = await adapter.open({
      operationId: "op2",
      sessionGeneration: 1,
      context: ctx,
      record: pending.record,
    });
    expect([...opened.bytes]).toEqual([...rootKey]);
  });

  it("rejects enrollment when identity is vault-sealed only (KP-26)", async () => {
    const pair = await generateAgeKeyPair();
    const rootKey = crypto.getRandomValues(new Uint8Array(ROOT_KEY_BYTES));
    const ctx = context("age_protector_cycle");
    const adapter = createAgeRecipientAdapter({
      recipients: [pair.recipient],
      resolveIdentity: async () => pair.identity,
      custody: "vault-sealed",
      sessionGeneration: 1,
    });
    await expect(
      adapter.enroll({
        operationId: "op1",
        sessionGeneration: 1,
        context: ctx,
        rootHandle: mintRootKeyHandle(ctx, rootKey),
      }),
    ).rejects.toMatchObject({ code: "bootstrap_cycle" });

    expect(
      ageIdentityIsIndependentRecovery({
        id: "x",
        recipient: pair.recipient,
        identity: pair.identity,
        custody: "vault-sealed",
      }),
    ).toBe(false);
    expect(() =>
      assertAgeRecoveryIndependent({
        id: "x",
        recipient: pair.recipient,
        identity: pair.identity,
        custody: "vault-sealed",
      }),
    ).toThrow(ProtectionError);
  });

  it("publishes untested public recipient without private key (KP-27)", async () => {
    const pair = await generateAgeKeyPair();
    const rootKey = crypto.getRandomValues(new Uint8Array(ROOT_KEY_BYTES));
    const ctx = context("age_public");
    const record = await publishUntestedAgeRecipient({
      context: ctx,
      rootKey,
      recipients: [pair.recipient],
    });
    expect(record.proofStatus).toBe("untested");
    expect(record.lastEvidence).toBeUndefined();
    expect(ageRecipientCanSatisfyLastVerifiedGuard(record)).toBe(false);

    // Ciphertext is real — the matching identity can still open it later.
    const adapter = createAgeRecipientAdapter({
      recipients: [pair.recipient],
      resolveIdentity: async () => pair.identity,
      custody: "external",
      sessionGeneration: 2,
    });
    const opened = await adapter.open({
      operationId: "op-open",
      sessionGeneration: 2,
      context: ctx,
      record,
    });
    expect([...opened.bytes]).toEqual([...rootKey]);
  });

  it("fails enrollment proof when the candidate capsule is corrupt (KP-09)", async () => {
    const pair = await generateAgeKeyPair();
    const rootKey = crypto.getRandomValues(new Uint8Array(ROOT_KEY_BYTES));
    const ctx = context("age_corrupt");
    const record = await publishUntestedAgeRecipient({
      context: ctx,
      rootKey,
      recipients: [pair.recipient],
    });
    const corrupt = {
      ...record,
      capsuleAgeB64: btoa("not-valid-age-ciphertext"),
    };
    const adapter = createAgeRecipientAdapter({
      recipients: [pair.recipient],
      resolveIdentity: async () => pair.identity,
      custody: "external",
      sessionGeneration: 3,
    });
    await expect(
      adapter.prove({
        operationId: "op-prove",
        sessionGeneration: 3,
        context: ctx,
        record: corrupt,
      }),
    ).rejects.toMatchObject({ code: "enrollment_proof_failed" });
  });
});
