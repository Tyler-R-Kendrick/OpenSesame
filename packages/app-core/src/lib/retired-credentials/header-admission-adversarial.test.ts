import { afterEach, beforeEach, expect, it } from "vitest";
import { kvDelete, kvGet, kvSet } from "../kv.js";
import { HEADER_KEY } from "../vault/protection/protector-enrollment.test-support.js";
import {
  retiredCredentialEnrollmentSupported,
  verifyCurrentCredential,
} from "./owner-auth.js";
import { PASSWORD, createRetiredCredentialFixture } from "./test-support.js";

let fixture: Awaited<ReturnType<typeof createRetiredCredentialFixture>>;
beforeEach(async () => {
  fixture = await createRetiredCredentialFixture();
});
afterEach(() => fixture.restore());

it("requires an actual current password wrap and supports a cryptographically valid legacy header", async () => {
  const header = JSON.parse(kvGet(HEADER_KEY) ?? "{}");
  const record = header.protection.records[0];
  header.protection = undefined;
  header.kdf = record.kdf;
  header.wrap = record.wrap;
  kvSet(HEADER_KEY, JSON.stringify(header));
  expect(retiredCredentialEnrollmentSupported("personal")).toBe(true);
  await expect(
    verifyCurrentCredential("personal", PASSWORD, async () => {}),
  ).resolves.toBeUndefined();
  header.wrap = undefined;
  kvSet(HEADER_KEY, JSON.stringify(header));
  expect(retiredCredentialEnrollmentSupported("personal")).toBe(false);
  await expect(
    verifyCurrentCredential("personal", PASSWORD, async () => {}),
  ).rejects.toThrow(/current password protector/);
  kvDelete(HEADER_KEY);
  expect(retiredCredentialEnrollmentSupported("personal")).toBe(false);
  await expect(
    verifyCurrentCredential("personal", PASSWORD, async () => {}),
  ).rejects.toThrow(/sealed vault/);
});

it("never converts any required second factor or a workload protector into password-only owner admission", async () => {
  const baseline = kvGet(HEADER_KEY) ?? "{}";
  for (const factor of ["totp", "email", "sms"]) {
    const header = JSON.parse(baseline);
    header.unlocks = { [factor]: { enabled: true } };
    kvSet(HEADER_KEY, JSON.stringify(header));
    expect(retiredCredentialEnrollmentSupported("personal")).toBe(false);
    await expect(
      verifyCurrentCredential("personal", PASSWORD, async () => {}),
    ).rejects.toThrow(/multi-factor ceremony/);
  }
  for (const factor of ["totpEnrolled", "emailEnrolled", "smsEnrolled"]) {
    const header = JSON.parse(baseline);
    header.protection.legacyGates = { [factor]: true };
    kvSet(HEADER_KEY, JSON.stringify(header));
    expect(retiredCredentialEnrollmentSupported("personal")).toBe(false);
    await expect(
      verifyCurrentCredential("personal", PASSWORD, async () => {}),
    ).rejects.toThrow(/multi-factor ceremony/);
  }
  const workload = JSON.parse(baseline);
  workload.protection.purpose = "workload-root";
  kvSet(HEADER_KEY, JSON.stringify(workload));
  await expect(
    verifyCurrentCredential("personal", PASSWORD, async () => {}),
  ).rejects.toThrow(/multi-factor ceremony/);
  for (const proofStatus of ["untested", "stale"]) {
    const header = JSON.parse(baseline);
    header.protection.records[0].proofStatus = proofStatus;
    kvSet(HEADER_KEY, JSON.stringify(header));
    await expect(
      verifyCurrentCredential("personal", PASSWORD, async () => {}),
    ).rejects.toThrow(/one verified password protector/);
  }
  expect(fixture.store.getSnapshot().status).toBe("unlocked");
});
