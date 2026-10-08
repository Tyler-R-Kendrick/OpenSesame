/** @vitest-environment node */
/**
 * RECOVERY-D/E — a key is reconstructed only after the approval quorum and
 * only from shares of the live generation; re-enrollment is the owner's and
 * retires the old shares; a drill reconstructs without arming anything.
 */
import { describe, expect, it } from "vitest";
import { ApprovalQuorumLedger } from "./approval.js";
import {
  authorizeReenrollment,
  createGenerationRegistry,
  reconstructAfterQuorum,
  replaceKeyCustodian,
  reportApprovalQuorum,
  revokeGeneration,
  rotateGeneration,
  runAvailabilityDrill,
} from "./ceremony.js";
import {
  NOW,
  approve,
  grant,
  key,
  keys,
  recoveryRequest,
} from "./recovery.fixture.js";
import {
  LocalShareMaterialGuard,
  combineRecoveryShares,
  splitRecoverySecret,
} from "./shares.js";

const context = {
  vaultRef: "v1",
  compartmentRef: "c1",
  policyRevision: 3,
  keyEpoch: 2,
};

async function sharesOf(
  secret: Uint8Array,
  macKey: Uint8Array,
  generation = 1,
) {
  return splitRecoverySecret({
    secret: new Uint8Array(secret),
    threshold: 2,
    total: 3,
    generation,
    macKey,
    ...context,
  });
}

async function quorum() {
  const secrets = keys();
  const request = await recoveryRequest();
  const ledger = new ApprovalQuorumLedger(secrets.registry, secrets.device, {
    thresholdK: 2,
    proofMaxAgeMs: 60_000,
  });
  const submit = async (ref: string, domain: string) =>
    ledger.submit({
      ...(await approve(
        request,
        grant("recovery_approver", ref, domain),
        secrets,
      )),
      request,
      nowMs: NOW,
    });
  return { ledger, request, submit };
}

describe("reconstructAfterQuorum", () => {
  it("refuses before quorum, then reconstructs the secret after it", async () => {
    const { ledger, request, submit } = await quorum();
    const secret = key();
    const macKey = key();
    const shares = await sharesOf(secret, macKey);
    const input = {
      ledger,
      request,
      shares: shares.slice(0, 2),
      macKey,
      requireQuorum: true,
      registry: createGenerationRegistry(),
      nowMs: NOW,
    };
    await submit("a1", "phone");
    expect(await reconstructAfterQuorum(input)).toEqual({
      kind: "failed",
      reason: "recovery_required: approval quorum not met",
    });
    expect(await reportApprovalQuorum(ledger, request, 1)).toMatchObject({
      kind: "failed",
    });
    await submit("a2", "hardware-token");
    expect(await reportApprovalQuorum(ledger, request, 2)).toEqual({
      kind: "approval_quorum_met",
      requestDigest: request.digest,
      independentApprovers: 2,
      wrappingSecret: null,
    });
    const out = await reconstructAfterQuorum(input);
    expect(out.kind).toBe("key_reconstructed");
    if (out.kind === "key_reconstructed") {
      expect([...out.wrappingSecret]).toEqual([...secret]);
    }
  });

  it("still needs enough verified shares once the quorum is met", async () => {
    const { ledger, request, submit } = await quorum();
    await submit("a1", "phone");
    await submit("a2", "hardware-token");
    const macKey = key();
    const shares = await sharesOf(key(), macKey);
    const base = {
      ledger,
      request,
      macKey,
      requireQuorum: true,
      registry: createGenerationRegistry(),
      nowMs: NOW,
    };
    expect(
      await reconstructAfterQuorum({ ...base, shares: shares.slice(0, 1) }),
    ).toMatchObject({ kind: "failed", reason: /insufficient/ });
    expect(
      await reconstructAfterQuorum({ ...base, shares, macKey: key() }),
    ).toMatchObject({ kind: "failed" });
  });

  it("refuses a revoked or superseded generation", async () => {
    const { ledger, request, submit } = await quorum();
    await submit("a1", "phone");
    await submit("a2", "hardware-token");
    const macKey = key();
    const shares = await sharesOf(key(), macKey);
    const registry = createGenerationRegistry();
    rotateGeneration(registry);
    const input = {
      ledger,
      request,
      shares,
      macKey,
      requireQuorum: true,
      nowMs: NOW,
    };
    expect(await reconstructAfterQuorum({ ...input, registry })).toMatchObject({
      reason: "retired_device: recovery generation revoked",
    });
    const ahead = createGenerationRegistry(5);
    expect(
      await reconstructAfterQuorum({ ...input, registry: ahead }),
    ).toMatchObject({ reason: /mixed_generations/ });
  });
});

describe("generations", () => {
  it("rotates by retiring the current one, and never revokes the live one in place", () => {
    const registry = createGenerationRegistry();
    expect(() => revokeGeneration(registry, 1)).toThrow(/without rotate/);
    expect(rotateGeneration(registry)).toBe(2);
    expect(registry.revoked.has(1)).toBe(true);
    revokeGeneration(registry, 7);
    expect(registry.revoked.has(7)).toBe(true);
  });

  it("replaces a key custodian only with one of the current generation", () => {
    const registry = createGenerationRegistry(2);
    const grants = [
      grant("key_custodian", "k1", "phone", 2),
      grant("recovery_approver", "k1", "phone", 2),
    ];
    const replacement = grant("key_custodian", "k2", "hardware-token", 2);
    expect(() =>
      replaceKeyCustodian({
        grants,
        revokePrincipalRef: "k1",
        replacement: grant("recovery_approver", "k2", "x", 2),
        registry,
      }),
    ).toThrow(/must be key_custodian/);
    expect(() =>
      replaceKeyCustodian({
        grants,
        revokePrincipalRef: "k1",
        replacement: grant("key_custodian", "k2", "x", 1),
        registry,
      }),
    ).toThrow(/current generation/);
    const next = replaceKeyCustodian({
      grants,
      revokePrincipalRef: "k1",
      replacement,
      registry,
    });
    expect(next).toEqual([
      { ...grants[0], revoked: true },
      grants[1],
      replacement,
    ]);
  });
});

describe("authorizeReenrollment", () => {
  const reenroll = (owner: ReturnType<typeof grant>, secret: Uint8Array) => {
    const registry = createGenerationRegistry();
    const localGuard = new LocalShareMaterialGuard(2);
    localGuard.stagePlaintextShare(new Uint8Array([1, 2, 3]));
    const macKey = key();
    const result = authorizeReenrollment({
      owner,
      registry,
      secret,
      threshold: 2,
      total: 3,
      macKey,
      localGuard,
      ...context,
    });
    return { registry, localGuard, macKey, result };
  };

  it("is the affected owner's alone", async () => {
    const { registry, localGuard, result } = reenroll(
      grant("recovery_approver", "a1", "phone"),
      key(),
    );
    expect(await result).toMatchObject({
      kind: "failed",
      reason: /affected owner required/,
    });
    expect(registry.current).toBe(1);
    expect(localGuard.stagedCount()).toBe(1);
  });

  it("rotates, clears staged plaintext, wipes the secret and mints live shares", async () => {
    const secret = key();
    const kept = new Uint8Array(secret);
    const { registry, localGuard, macKey, result } = reenroll(
      grant("affected_owner", "o1", "phone"),
      secret,
    );
    const out = await result;
    expect(out.kind).toBe("reenroll_authorized");
    if (out.kind !== "reenroll_authorized") return;
    expect(out.newGeneration).toBe(2);
    expect(registry.revoked.has(1)).toBe(true);
    expect(localGuard.stagedCount()).toBe(0);
    expect(secret.every((b) => b === 0)).toBe(true);
    expect(out.newShares.every((s) => s.generation === 2)).toBe(true);
    const drill = await runAvailabilityDrill({
      shares: out.newShares.slice(1),
      macKey,
      expect: { generation: 2, threshold: 2, ...context },
    });
    expect(drill).toEqual({
      kind: "drill_passed",
      reconstructed: true,
      armed: false,
    });
    // The new generation's shares carry the same secret, not a fresh one.
    const again = await combineRecoveryShares({
      shares: out.newShares.slice(0, 2),
      macKey,
      expect: { generation: 2, threshold: 2, ...context },
    });
    expect([...again]).toEqual([...kept]);
  });
});

describe("runAvailabilityDrill", () => {
  it("fails without enough shares or on the wrong generation", async () => {
    const macKey = key();
    const shares = await sharesOf(key(), macKey);
    const expectGen = (generation: number) => ({
      generation,
      threshold: 2,
      ...context,
    });
    expect(
      await runAvailabilityDrill({
        shares: shares.slice(0, 1),
        macKey,
        expect: expectGen(1),
      }),
    ).toMatchObject({ kind: "failed", reason: /insufficient/ });
    expect(
      await runAvailabilityDrill({ shares, macKey, expect: expectGen(2) }),
    ).toMatchObject({ kind: "failed" });
  });
});
