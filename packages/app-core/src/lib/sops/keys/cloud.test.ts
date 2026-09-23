/** @vitest-environment node */
/**
 * SB-051 … SB-057: the cloud adapters' wire contract, key binding, and
 * honest failure reporting. These are contract tests against a mocked
 * transport — a different evidence class from a live cross-origin call,
 * which `pnpm verify:sops-cloud-live` reports separately.
 */
import { describe, expect, it, vi } from "vitest";
import { SopsError } from "../errors.js";
import { DATA_KEY_BYTES, SHARE_BYTES } from "../limits.js";
import type { ForeignMasterKey } from "../metadata.js";
import { map, setEntry, str } from "../model.js";
import {
  awsKmsProvider,
  azureKeyVaultProvider,
  b64UrlRaw,
  gcpKmsProvider,
  unb64UrlRaw,
} from "./cloud.js";

const NEVER = new AbortController().signal;
const ARN = "arn:aws:kms:us-east-1:111122223333:key/abcd-1234";

function kmsKey(arn = ARN, context?: Record<string, string>): ForeignMasterKey {
  const items = [setEntry("arn", str(arn)), setEntry("enc", str("QUJD"))];
  if (context) {
    items.push(
      setEntry(
        "context",
        map(
          Object.entries(context).map(([key, value]) =>
            setEntry(key, str(value)),
          ),
        ),
      ),
    );
  }
  return { kind: "kms", enc: "QUJD", locator: arn, raw: map(items) };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const dataKey = new Uint8Array(DATA_KEY_BYTES).fill(7);
const share = new Uint8Array(SHARE_BYTES).fill(9);

describe("SB-053/056 AWS KMS carries the data key or a share, with upstream's encodings", () => {
  it("sends standard base64, preserves the encryption context, and accepts a 33-byte share", async () => {
    const calls: {
      url: string;
      body: Record<string, unknown>;
      headers: Headers;
    }[] = [];
    const http = vi.fn(async (url: string, init: RequestInit) => {
      const headers = new Headers(init.headers);
      const body = JSON.parse(String(init.body));
      calls.push({ url, body, headers });
      if (headers.get("x-amz-target") === "TrentService.Encrypt") {
        return json({ CiphertextBlob: "Y2lwaGVy", KeyId: ARN });
      }
      return json({
        Plaintext:
          body.CiphertextBlob === "Y2lwaGVy" ? b64(share) : b64(dataKey),
        KeyId: ARN,
      });
    });
    const provider = awsKmsProvider({
      keyArn: ARN,
      region: "us-east-1",
      authorization: async () => ({ authorization: "AWS4-HMAC-SHA256 ..." }),
      http,
    });
    const wrapped = await provider.wrap(
      kmsKey(ARN, { role: "sops" }),
      share,
      NEVER,
    );
    expect(wrapped.enc).toBe("Y2lwaGVy");
    expect(calls[0]?.url).toBe("https://kms.us-east-1.amazonaws.com/");
    expect(calls[0]?.body.KeyId).toBe(ARN);
    expect(calls[0]?.body.Plaintext).toBe(b64(share));
    expect(calls[0]?.body.EncryptionContext).toEqual({ role: "sops" });
    const opened = await provider.unwrap(
      { ...kmsKey(), enc: "Y2lwaGVy" },
      NEVER,
    );
    expect(opened?.byteLength).toBe(SHARE_BYTES);
  });

  it("refuses a different account, region, or key, and a substring match (SB-052)", async () => {
    const http = vi.fn(async () =>
      json({
        Plaintext: b64(dataKey),
        KeyId: "arn:aws:kms:us-east-1:999:key/other",
      }),
    );
    const provider = awsKmsProvider({
      keyArn: ARN,
      region: "us-east-1",
      authorization: async () => ({}),
      http,
    });
    // A document naming another key is simply not this provider's business.
    expect(
      await provider.unwrap(
        kmsKey("arn:aws:kms:us-west-2:111122223333:key/abcd-1234"),
        NEVER,
      ),
    ).toBeNull();
    expect(await provider.unwrap(kmsKey("abcd-1234"), NEVER)).toBeNull();
    // A provider that answers for a different key is a refusal, not a key.
    await expect(provider.unwrap(kmsKey(), NEVER)).rejects.toMatchObject({
      code: "provider_denied",
    });
  });

  it("reports an unreachable provider without claiming to know why (SB-057)", async () => {
    const http = vi.fn(async () => {
      throw new TypeError("Failed to fetch");
    });
    const provider = awsKmsProvider({
      keyArn: ARN,
      region: "us-east-1",
      authorization: async () => ({}),
      http,
    });
    await expect(provider.unwrap(kmsKey(), NEVER)).rejects.toMatchObject({
      code: "provider_unavailable",
    });
    await expect(provider.unwrap(kmsKey(), NEVER)).rejects.toThrow(
      /network or CORS/u,
    );
  });

  it("refuses a payload that is neither a data key nor a share", async () => {
    const http = vi.fn(async () =>
      json({ Plaintext: b64(new Uint8Array(16)), KeyId: ARN }),
    );
    const provider = awsKmsProvider({
      keyArn: ARN,
      region: "us-east-1",
      authorization: async () => ({}),
      http,
    });
    await expect(provider.unwrap(kmsKey(), NEVER)).rejects.toBeInstanceOf(
      SopsError,
    );
    await expect(
      provider.wrap(kmsKey(), new Uint8Array(16), NEVER),
    ).rejects.toMatchObject({ code: "malformed_encoding" });
  });
});

describe("SB-054 Azure Key Vault uses RSA-OAEP-256 and unpadded URL-safe base64", () => {
  const key: ForeignMasterKey = {
    kind: "azure_kv",
    enc: "Y2lwaGVy",
    locator: "https://vault.vault.azure.net",
    raw: map([
      setEntry("vault_url", str("https://vault.vault.azure.net")),
      setEntry("name", str("k")),
      setEntry("version", str("v1")),
    ]),
  };

  it("names the concrete key version and encodes the payload without padding", async () => {
    const calls: { url: string; body: Record<string, unknown> }[] = [];
    const http = vi.fn(async (url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      calls.push({ url, body });
      return json({
        value: url.includes("encrypt") ? "Y2lwaGVy" : b64UrlRaw(dataKey),
      });
    });
    const provider = azureKeyVaultProvider({
      vaultUrl: "https://vault.vault.azure.net",
      name: "k",
      version: "v1",
      authorization: async () => ({ authorization: "Bearer t" }),
      http,
    });
    const wrapped = await provider.wrap(key, dataKey, NEVER);
    expect(wrapped.enc).toBe("Y2lwaGVy");
    expect(calls[0]?.url).toBe(
      "https://vault.vault.azure.net/keys/k/v1/encrypt?api-version=7.4",
    );
    expect(calls[0]?.body.alg).toBe("RSA-OAEP-256");
    expect(String(calls[0]?.body.value)).not.toMatch(/[+/=]/u);
    const opened = await provider.unwrap(key, NEVER);
    expect(opened?.byteLength).toBe(DATA_KEY_BYTES);
  });

  it("refuses a blank key version rather than silently taking the latest", () => {
    expect(() =>
      azureKeyVaultProvider({
        vaultUrl: "https://v.vault.azure.net",
        name: "k",
        version: "",
        authorization: async () => ({}),
        http: vi.fn(),
      }),
    ).toThrow(/version must be explicit/u);
  });

  it("round-trips unpadded URL-safe base64 exactly", () => {
    for (const length of [DATA_KEY_BYTES, SHARE_BYTES, 1, 2, 3]) {
      const bytes = new Uint8Array(length).map(
        (_, index) => (index * 37 + 251) % 256,
      );
      expect(unb64UrlRaw(b64UrlRaw(bytes))).toEqual(bytes);
    }
  });
});

describe("SB-055 GCP KMS names the full resource and uses standard base64", () => {
  const key: ForeignMasterKey = {
    kind: "gcp_kms",
    enc: "Y2lwaGVy",
    locator: "projects/p/locations/l/keyRings/r/cryptoKeys/k",
    raw: map([
      setEntry(
        "resource_id",
        str("projects/p/locations/l/keyRings/r/cryptoKeys/k"),
      ),
      setEntry("enc", str("Y2lwaGVy")),
    ]),
  };

  it("posts to the resource's encrypt and decrypt methods", async () => {
    const calls: string[] = [];
    const http = vi.fn(async (url: string) => {
      calls.push(url);
      return json(
        url.endsWith(":encrypt")
          ? { ciphertext: "Y2lwaGVy" }
          : { plaintext: b64(dataKey) },
      );
    });
    const provider = gcpKmsProvider({
      resourceId: "projects/p/locations/l/keyRings/r/cryptoKeys/k",
      authorization: async () => ({ authorization: "Bearer t" }),
      http,
    });
    expect((await provider.wrap(key, dataKey, NEVER)).enc).toBe("Y2lwaGVy");
    expect(calls[0]).toBe(
      "https://cloudkms.googleapis.com/v1/projects/p/locations/l/keyRings/r/cryptoKeys/k:encrypt",
    );
    expect((await provider.unwrap(key, NEVER))?.byteLength).toBe(
      DATA_KEY_BYTES,
    );
    expect(
      await provider.unwrap({ ...key, locator: "projects/other/x" }, NEVER),
    ).toBeNull();
  });
});

function b64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}
