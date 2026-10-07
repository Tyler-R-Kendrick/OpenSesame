import { beforeEach, describe, expect, it, vi } from "vitest";
import { writeAwsKmsConfig } from "../../aws-kms-config.js";
import { kvGet } from "../../kv.js";
import { PERSONAL_TOMB } from "../../vfs.js";
import { awsKmsConnection } from "./cloud-connection.js";
import { ProtectionError } from "./errors.js";
import {
  GCP_KEY,
  HEADER_KEY,
  KEY_ARN,
  OTHER_ARN,
  aws,
  awsFake,
  clearVaultSurface,
  gcpFake,
  openStore,
  reopen,
} from "./protector-enrollment.test-support.js";
import { protectorCanBeTested } from "./protector-proof.js";

describe("enrolling a cloud KMS key", () => {
  beforeEach(clearVaultSurface);

  it("wraps only a 32-byte secret, proves the round trip, and re-proves next session", async () => {
    const store = await openStore();
    const transport = awsFake(KEY_ARN);
    const candidate = await store.protection.enrollExternal(aws(transport));
    expect(candidate.record.kind).toBe("aws-kms");
    expect(candidate.record.proofStatus).toBe("verified");
    expect(candidate.record.lastEvidence?.kind).toBe("cloud-live");
    await store.protection.commitEnrollment(candidate.operationId);

    const again = await reopen(store);
    const id = candidate.record.protectorId;
    const proved = await again.protection.testProtector(id, {
      aws: aws(transport),
    });
    expect(proved.proofStatus).toBe("verified");

    await expect(
      again.protection.testProtector(id, {
        aws: aws(awsFake(OTHER_ARN), OTHER_ARN),
      }),
    ).rejects.toMatchObject({ code: "context_mismatch" });
    await expect(
      again.protection.testProtector(id, {
        aws: aws(awsFake(KEY_ARN, { deny: true })),
      }),
    ).rejects.toMatchObject({ code: "provider_denied" });
    await expect(again.protection.testProtector(id, {})).rejects.toMatchObject({
      code: "unavailable",
    });
  });

  it("never lets the credential reach the header", async () => {
    const store = await openStore();
    await writeAwsKmsConfig(PERSONAL_TOMB, {
      keyArn: KEY_ARN,
      accessKeyId: "AKIATESTACCESSKEY1",
      secretAccessKey: "sk-live-canary-secret",
    });
    const seen: string[] = [];
    const connection = await awsKmsConnection(
      PERSONAL_TOMB,
      async (url, init) => {
        seen.push(String(url));
        return new Response("{}", { status: 400 });
      },
    );
    expect(connection.keyArn).toBe(KEY_ARN);
    expect(connection.connectionConfigVersion).toBe("1");
    await expect(
      store.protection.enrollExternal({ kind: "aws-kms", ...connection }),
    ).rejects.toMatchObject({ code: "provider_denied" });
    expect(seen).toEqual(["https://kms.us-west-2.amazonaws.com/"]);
    expect(kvGet(HEADER_KEY) ?? "").not.toContain("sk-live-canary-secret");
    expect(
      store.protection.listProtectors().some((r) => r.kind === "aws-kms"),
    ).toBe(false);
  });

  it("asks for the saved connection first when none is sealed", async () => {
    await openStore();
    await expect(awsKmsConnection(PERSONAL_TOMB)).rejects.toMatchObject({
      code: "unavailable",
    });
  });

  it("enrolls Google Cloud KMS the same way and refuses a repeat", async () => {
    const store = await openStore();
    const transport = gcpFake();
    const gcp = {
      kind: "gcp-kms" as const,
      transport,
      keyName: GCP_KEY,
      connectionId: "gcp-kms",
      connectionConfigVersion: "3",
    };
    const candidate = await store.protection.enrollExternal(gcp);
    expect(candidate.record.kind).toBe("gcp-kms");
    expect(candidate.record.proofStatus).toBe("verified");
    await store.protection.commitEnrollment(candidate.operationId);
    const proved = await store.protection.testProtector(
      candidate.record.protectorId,
      { gcp },
    );
    expect(proved.kind === "gcp-kms" && proved.connectionConfigVersion).toBe(
      "3",
    );
    await expect(store.protection.enrollExternal(gcp)).rejects.toMatchObject({
      code: "duplicate_protector_id",
    });
  });

  it("drops an enrollment whose vault locked while the provider was answering", async () => {
    const store = await openStore();
    let cancel: () => void = () => undefined;
    const gcp = {
      kind: "gcp-kms" as const,
      transport: gcpFake(() => cancel()),
      keyName: GCP_KEY,
      connectionId: "gcp-kms",
      connectionConfigVersion: "1",
    };
    cancel = () => store.protection.cancelPendingOps();
    await expect(store.protection.enrollExternal(gcp)).rejects.toBeInstanceOf(
      ProtectionError,
    );
    expect(
      store.protection.listProtectors().some((r) => r.kind === "gcp-kms"),
    ).toBe(false);
  });
});

describe("what Test is offered for", () => {
  it("names the kinds whose capsule a browser can open", () => {
    for (const kind of [
      "recovery-key",
      "age-recipient",
      "age-webauthn",
      "aws-kms",
      "gcp-kms",
    ] as const) {
      expect(protectorCanBeTested(kind)).toBe(true);
    }
    for (const kind of [
      "password",
      "pin",
      "webauthn-prf",
      "yubikey-piv-age",
      "azure-key-vault-keys",
      "device-local",
    ] as const) {
      expect(protectorCanBeTested(kind)).toBe(false);
    }
  });
});

it("never dispatches a cloud proof after its actual host locks during lazy adapter admission", async () => {
  await clearVaultSurface();
  const store = await openStore();
  const transport = awsFake(KEY_ARN);
  const enrolled = await store.protection.enrollExternal(aws(transport));
  await store.protection.commitEnrollment(enrolled.operationId);
  const decrypt = vi.spyOn(transport, "decrypt");
  try {
    await expect(
      store.protection.testProtector(enrolled.record.protectorId, {
        aws: aws(transport),
      }),
    ).resolves.toMatchObject({ proofStatus: "verified" });
    decrypt.mockClear();
    const material = {
      get aws() {
        queueMicrotask(() => store.lock());
        return aws(transport);
      },
    };
    await expect(
      store.protection.testProtector(enrolled.record.protectorId, material),
    ).rejects.toThrow();
    expect(decrypt).not.toHaveBeenCalled();
  } finally {
    decrypt.mockRestore();
    store.lock();
    await store.flushPendingWrites();
  }
});
