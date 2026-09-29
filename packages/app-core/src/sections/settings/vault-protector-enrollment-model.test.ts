import { beforeEach, describe, expect, it } from "vitest";
import { generateAgeKeyPair, writeAgeKeyConfig } from "../../lib/age-keys.js";
import { AGE_KEYS_CONFIG_PATH } from "../../lib/age-keys.js";
import { AWS_KMS_CONFIG_PATH } from "../../lib/aws-kms-config.js";
import { GCP_KMS_CONFIG_PATH } from "../../lib/gcp-kms-config.js";
import { kvDelete, kvGet } from "../../lib/kv.js";
import { ATTEMPTS_KEY, VaultStore } from "../../lib/vault/store.js";
import { LEGACY_PREFS_KEY } from "../../lib/vault/tomb-migration.js";
import {
  BODY_PATH,
  HEADER_PATH,
  INDEX_PATH,
  MIGRATION_MARKER_PATH,
  PERSONAL_TOMB,
  tombFileKey,
  vfsFlush,
} from "../../lib/vfs.js";
import {
  enrollAgeRecipientFlow,
  enrollAwsKmsFlow,
  enrollGcpKmsFlow,
  testAgeRecipientFlow,
  testCloudFlow,
} from "./vault-protector-enrollment-model.js";

const PASSWORD = "correct horse battery staple";
const HEADER_KEY = tombFileKey(PERSONAL_TOMB, HEADER_PATH);
const KEY_ARN =
  "arn:aws:kms:us-west-2:123456789012:key/12345678-1234-1234-1234-1234567890ab";
const GCP_KEY = "projects/p1/locations/global/keyRings/ring/cryptoKeys/root";

async function clearSurface(): Promise<void> {
  await vfsFlush();
  kvDelete(ATTEMPTS_KEY);
  kvDelete(HEADER_KEY);
  for (const path of [
    BODY_PATH,
    MIGRATION_MARKER_PATH,
    INDEX_PATH,
    AWS_KMS_CONFIG_PATH,
    GCP_KMS_CONFIG_PATH,
    AGE_KEYS_CONFIG_PATH,
  ]) {
    kvDelete(tombFileKey(PERSONAL_TOMB, path));
  }
  kvDelete(LEGACY_PREFS_KEY);
}

const b64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));
const unb64 = (text: string) =>
  Uint8Array.from(atob(text), (c) => c.charCodeAt(0));

type AwsCall = { url: string; auth: string; target: string };
type GcpCall = { url: string; auth: string };

/** AWS KMS's JSON API, as far as the transport speaks it. */
function awsKmsFetch(log: AwsCall[]) {
  const held = new Map<string, string>();
  const impl: typeof fetch = async (url, init) => {
    const headers = new Headers(init?.headers);
    const target = headers.get("x-amz-target") ?? "";
    log.push({
      url: String(url),
      auth: headers.get("authorization") ?? "",
      target,
    });
    const body = JSON.parse(String(init?.body));
    if (target === "TrentService.Encrypt") {
      const ct = b64(crypto.getRandomValues(new Uint8Array(40)));
      held.set(ct, body.Plaintext);
      return Response.json({ CiphertextBlob: ct, KeyId: body.KeyId });
    }
    const plaintext = held.get(body.CiphertextBlob);
    if (!plaintext) return new Response("{}", { status: 400 });
    return Response.json({ Plaintext: plaintext, KeyId: KEY_ARN });
  };
  return impl;
}

async function serviceAccountJson(): Promise<string> {
  const pair = await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  );
  const pkcs8 = new Uint8Array(
    await crypto.subtle.exportKey("pkcs8", pair.privateKey),
  );
  // Armor around a key the test just generated — never a real key.
  const label = "PRIVATE KEY";
  return JSON.stringify({
    client_email: "vault@p1.iam.gserviceaccount.com",
    private_key: `-----BEGIN ${label}-----\n${b64(pkcs8)}\n-----END ${label}-----\n`,
  });
}

/** Cloud KMS REST plus the Google token endpoint. */
function gcpFetch(log: GcpCall[]) {
  const held = new Map<string, string>();
  const impl: typeof fetch = async (url, init) => {
    const headers = new Headers(init?.headers);
    log.push({ url: String(url), auth: headers.get("authorization") ?? "" });
    if (String(url) === "https://oauth2.googleapis.com/token") {
      return Response.json({ access_token: "ya29.minted" });
    }
    const body = JSON.parse(String(init?.body));
    if (String(url).endsWith(":encrypt")) {
      const ct = b64(crypto.getRandomValues(new Uint8Array(40)));
      held.set(ct, body.plaintext);
      return Response.json({
        ciphertext: ct,
        name: `${GCP_KEY}/cryptoKeyVersions/1`,
        verifiedPlaintextCrc32c: true,
      });
    }
    const plaintext = held.get(body.ciphertext);
    if (!plaintext) return new Response("{}", { status: 400 });
    return Response.json({ plaintext });
  };
  return impl;
}

async function openStore(): Promise<VaultStore> {
  const store = new VaultStore();
  await store.create(PASSWORD);
  return store;
}

describe("enrolling an age recipient from the sheet", () => {
  beforeEach(clearSurface);

  it("hands the identity over before it commits, and it is never stored", async () => {
    const store = await openStore();
    const delivered: { identity: string; recipient: string }[] = [];
    const enrolled = await enrollAgeRecipientFlow({
      protection: store.protection,
      tomb: PERSONAL_TOMB,
      entry: { recipient: "", identity: "" },
      deliver: (d) => {
        // Not yet in the manifest when it is handed over.
        expect(
          store.protection
            .listProtectors()
            .some((r) => r.kind === "age-recipient"),
        ).toBe(false);
        delivered.push(d);
      },
    });
    expect(enrolled.proven).toBe(true);
    expect(delivered).toHaveLength(1);
    expect(delivered[0]?.recipient).toMatch(/^age1/);
    expect(kvGet(HEADER_KEY) ?? "").not.toContain(
      delivered[0]?.identity ?? "-",
    );

    await testAgeRecipientFlow({
      protection: store.protection,
      tomb: PERSONAL_TOMB,
      protectorId: enrolled.protectorId,
      identity: ` ${delivered[0]?.identity} `,
    });
  });

  it("does not commit when the identity could not be handed over", async () => {
    const store = await openStore();
    await expect(
      enrollAgeRecipientFlow({
        protection: store.protection,
        tomb: PERSONAL_TOMB,
        entry: { recipient: "", identity: "" },
        deliver: () => {
          throw new Error("download blocked");
        },
      }),
    ).rejects.toThrow("download blocked");
    expect(
      store.protection.listProtectors().some((r) => r.kind === "age-recipient"),
    ).toBe(false);
  });

  it("refuses the identity Age keys seals inside this vault", async () => {
    const store = await openStore();
    const pair = await generateAgeKeyPair();
    await writeAgeKeyConfig(PERSONAL_TOMB, {
      recipients: [pair.recipient],
      identity: pair.identity,
    });
    await expect(
      enrollAgeRecipientFlow({
        protection: store.protection,
        tomb: PERSONAL_TOMB,
        entry: { recipient: pair.recipient, identity: pair.identity },
        deliver: () => undefined,
      }),
    ).rejects.toMatchObject({ code: "bootstrap_cycle" });
  });

  it("publishes a pasted recipient untested and a Test with its identity proves it", async () => {
    const store = await openStore();
    const pair = await generateAgeKeyPair();
    const enrolled = await enrollAgeRecipientFlow({
      protection: store.protection,
      tomb: PERSONAL_TOMB,
      entry: { recipient: ` ${pair.recipient}\n`, identity: "" },
      deliver: () => undefined,
    });
    expect(enrolled.proven).toBe(false);
    await testAgeRecipientFlow({
      protection: store.protection,
      tomb: PERSONAL_TOMB,
      protectorId: enrolled.protectorId,
      identity: pair.identity,
    });
    expect(
      store.protection
        .listProtectors()
        .find((r) => r.protectorId === enrolled.protectorId)?.proofStatus,
    ).toBe("verified");
  });
});

describe("enrolling AWS KMS through the sealed connection", () => {
  beforeEach(clearSurface);

  it("saves the connection, signs real KMS requests, and proves the round trip", async () => {
    const store = await openStore();
    const log: AwsCall[] = [];
    const fetchImpl = awsKmsFetch(log);
    const enrolled = await enrollAwsKmsFlow({
      protection: store.protection,
      tomb: PERSONAL_TOMB,
      fetchImpl,
      entry: {
        keyArn: KEY_ARN,
        region: "",
        accessKeyId: "AKIATESTACCESSKEY1",
        secretAccessKey: "sk-canary-secret",
        sessionToken: "",
        label: "",
      },
    });
    expect(enrolled.proven).toBe(true);
    expect(log.map((call) => call.target)).toEqual([
      "TrentService.Encrypt",
      "TrentService.Decrypt",
    ]);
    for (const call of log) {
      expect(call.url).toBe("https://kms.us-west-2.amazonaws.com/");
      expect(call.auth).toMatch(
        /^AWS4-HMAC-SHA256 Credential=AKIATESTACCESSKEY1\//,
      );
      expect(call.auth).not.toContain("sk-canary-secret");
    }
    expect(kvGet(HEADER_KEY) ?? "").not.toContain("sk-canary-secret");
    const record = store.protection
      .listProtectors()
      .find((r) => r.protectorId === enrolled.protectorId);
    expect(record?.kind === "aws-kms" && record.keyArn).toBe(KEY_ARN);

    await testCloudFlow({
      protection: store.protection,
      tomb: PERSONAL_TOMB,
      protectorId: enrolled.protectorId,
      kind: "aws-kms",
      fetchImpl,
    });
    expect(log).toHaveLength(3);
  });

  it("names what is wrong when the saved credential is not accepted", async () => {
    const store = await openStore();
    await expect(
      enrollAwsKmsFlow({
        protection: store.protection,
        tomb: PERSONAL_TOMB,
        fetchImpl: async () => new Response("{}", { status: 403 }),
        entry: {
          keyArn: KEY_ARN,
          region: "",
          accessKeyId: "AKIATESTACCESSKEY1",
          secretAccessKey: "sk-canary-secret",
          sessionToken: "",
          label: "",
        },
      }),
    ).rejects.toMatchObject({ code: "provider_denied" });
    expect(
      store.protection.listProtectors().some((r) => r.kind === "aws-kms"),
    ).toBe(false);
    await expect(
      enrollAwsKmsFlow({
        protection: store.protection,
        tomb: PERSONAL_TOMB,
        entry: {
          keyArn: "arn:aws:kms:us-west-2:123456789012:alias/prod",
          region: "",
          accessKeyId: "AKIATESTACCESSKEY1",
          secretAccessKey: "x",
          sessionToken: "",
          label: "",
        },
      }),
    ).rejects.toThrow(/alias/);
  });
});

describe("enrolling Google Cloud KMS through the sealed connection", () => {
  beforeEach(clearSurface);

  it("mints a token in memory, wraps and re-opens, and never stores the token", async () => {
    const store = await openStore();
    const log: GcpCall[] = [];
    const fetchImpl = gcpFetch(log);
    const enrolled = await enrollGcpKmsFlow({
      protection: store.protection,
      tomb: PERSONAL_TOMB,
      fetchImpl,
      entry: {
        keyName: GCP_KEY,
        projectId: "",
        serviceAccountJson: await serviceAccountJson(),
        label: "",
      },
    });
    expect(enrolled.proven).toBe(true);
    expect(log.map((call) => call.url)).toEqual([
      "https://oauth2.googleapis.com/token",
      `https://cloudkms.googleapis.com/v1/${GCP_KEY}:encrypt`,
      `https://cloudkms.googleapis.com/v1/${GCP_KEY}:decrypt`,
    ]);
    expect(log[1]?.auth).toBe("Bearer ya29.minted");
    expect(kvGet(HEADER_KEY) ?? "").not.toContain("ya29.minted");

    await testCloudFlow({
      protection: store.protection,
      tomb: PERSONAL_TOMB,
      protectorId: enrolled.protectorId,
      kind: "gcp-kms",
      fetchImpl,
    });
  });
});
