import { beforeEach, describe, expect, it } from "vitest";
import { generateAgeKeyPair } from "../../age-keys.js";
import { kvGet } from "../../kv.js";
import { VaultStore } from "../store.js";
import { ProtectionError } from "./errors.js";
import {
  HEADER_KEY,
  PASSWORD,
  clearVaultSurface,
  openStore,
  reopen,
} from "./protector-enrollment.test-support.js";

describe("enrolling an age recipient", () => {
  beforeEach(clearVaultSurface);

  it("mints a key pair, proves it, and the identity reopens the root next session", async () => {
    const store = await openStore();
    const candidate = await store.protection.enrollExternal({
      kind: "age-recipient",
    });
    const identity = candidate.ageIdentitySecret;
    expect(identity).toMatch(/^AGE-SECRET-KEY-1/);
    expect(candidate.record.proofStatus).toBe("verified");
    expect(candidate.record.lastEvidence?.kind).toBe("software-roundtrip");
    await store.protection.commitEnrollment(candidate.operationId);

    // The identity is shown once: nothing the header persists contains it.
    expect(kvGet(HEADER_KEY) ?? "").not.toContain(identity ?? "unreachable");

    const again = await reopen(store);
    const enrolled = again.protection
      .listProtectors()
      .find((r) => r.kind === "age-recipient");
    if (!enrolled || !identity) throw new Error("expected the protector");
    const proved = await again.protection.testProtector(enrolled.protectorId, {
      ageIdentity: identity,
    });
    expect(proved.proofStatus).toBe("verified");
    const stranger = await generateAgeKeyPair();
    await expect(
      again.protection.testProtector(enrolled.protectorId, {
        ageIdentity: stranger.identity,
      }),
    ).rejects.toMatchObject({ code: "enrollment_proof_failed" });
  });

  it("publishes a pasted recipient untested until an identity proves it", async () => {
    const store = await openStore();
    const pair = await generateAgeKeyPair();
    const candidate = await store.protection.enrollExternal({
      kind: "age-recipient",
      recipients: [pair.recipient],
    });
    expect(candidate.ageIdentitySecret).toBeUndefined();
    expect(candidate.record.proofStatus).toBe("untested");
    await store.protection.commitEnrollment(candidate.operationId);
    const id = candidate.record.protectorId;

    const proved = await store.protection.testProtector(id, {
      ageIdentity: pair.identity,
    });
    expect(proved.proofStatus).toBe("verified");
    expect(
      store.protection.listProtectors().find((r) => r.protectorId === id)
        ?.proofStatus,
    ).toBe("verified");
  });

  it("proves at enrollment when the identity for a pasted recipient is given", async () => {
    const store = await openStore();
    const pair = await generateAgeKeyPair();
    const candidate = await store.protection.enrollExternal({
      kind: "age-recipient",
      recipients: [pair.recipient],
      identity: pair.identity,
    });
    expect(candidate.record.proofStatus).toBe("verified");
    const stranger = await generateAgeKeyPair();
    await expect(
      store.protection.enrollExternal({
        kind: "age-recipient",
        recipients: [pair.recipient],
        identity: stranger.identity,
      }),
    ).rejects.toMatchObject({ code: "enrollment_proof_failed" });
  });

  it("refuses an identity the vault itself seals (KP-26)", async () => {
    const store = await openStore();
    const pair = await generateAgeKeyPair();
    await expect(
      store.protection.enrollExternal({
        kind: "age-recipient",
        recipients: [pair.recipient],
        identity: pair.identity,
        vaultSealedIdentities: [pair.identity],
      }),
    ).rejects.toMatchObject({ code: "bootstrap_cycle" });
  });

  it("refuses text that is not a recipient, an identity without one, and a repeat", async () => {
    const store = await openStore();
    await expect(
      store.protection.enrollExternal({
        kind: "age-recipient",
        recipients: ["not-an-age-recipient"],
      }),
    ).rejects.toMatchObject({ code: "malformed_encoding" });
    const pair = await generateAgeKeyPair();
    await expect(
      store.protection.enrollExternal({
        kind: "age-recipient",
        identity: pair.identity,
      }),
    ).rejects.toMatchObject({ code: "malformed_encoding" });
    const first = await store.protection.enrollExternal({
      kind: "age-recipient",
      recipients: [pair.recipient],
    });
    await store.protection.commitEnrollment(first.operationId);
    await expect(
      store.protection.enrollExternal({
        kind: "age-recipient",
        recipients: [pair.recipient],
      }),
    ).rejects.toMatchObject({ code: "duplicate_protector_id" });
  });

  it("refuses an age plugin recipient, which is what a YubiKey produces (ADR 0152)", async () => {
    const store = await openStore();
    // Well-formed bech32 with a valid checksum under the plugin's own prefix:
    // the library encrypts to native recipients only, and a plugin recipient
    // needs the plugin binary, which a page cannot run.
    const plugin =
      "age1yubikey1qv9pzxqlyckngw6zf9g9whn9d3eh4qvg37tfmf9tk2uup37w6hwwx46jajg";
    await expect(
      store.protection.enrollExternal({
        kind: "age-recipient",
        recipients: [plugin],
      }),
    ).rejects.toMatchObject({ code: "malformed_encoding" });
    expect(
      store.protection.listProtectors().some((r) => r.kind === "age-recipient"),
    ).toBe(false);
  });

  it("refuses a guest, and leaves nothing pending after a cancel", async () => {
    const member = await openStore();
    member.lock();
    const guest = new VaultStore();
    await guest.createGuest();
    await expect(
      guest.protection.enrollExternal({ kind: "age-recipient" }),
    ).rejects.toMatchObject({ code: "unavailable" });

    const store = new VaultStore();
    await store.unlock(PASSWORD);
    const candidate = await store.protection.enrollExternal({
      kind: "age-recipient",
    });
    store.protection.cancelPendingOps();
    await expect(
      store.protection.commitEnrollment(candidate.operationId),
    ).rejects.toBeInstanceOf(ProtectionError);
    expect(
      store.protection.listProtectors().some((r) => r.kind === "age-recipient"),
    ).toBe(false);
  });
});
