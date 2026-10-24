import {
  type BoundaryValue,
  isJsonObject,
  isString,
} from "@opensesame/os-domain";
import type { ProtectionContext } from "@opensesame/vault-core";
import { describe, expect, it } from "vitest";
import {
  b64ToBytes,
  bytesToB64,
  mintWrappingSecret,
} from "./cloud-wrapping-secret.js";
import { createGcpKmsHttpsTransport } from "./gcp-kms-https.js";
import { crc32cDecimalString, createGcpKmsProtector } from "./gcp-kms.js";

const KEY_NAME =
  "projects/demo/locations/us-central1/keyRings/ring/cryptoKeys/vault-root";
const KEY_VERSION = `${KEY_NAME}/cryptoKeyVersions/1`;
const CIPHERTEXT = new Uint8Array([1, 2, 3]);
const CONTEXT: ProtectionContext = {
  vaultId: "vault-1",
  rootKeyId: "root-1",
  rootEpoch: 1,
  protectorId: "prot-gcp-1",
  purpose: "human-vault-root",
};

describe("GCP KMS REST checksum wire contract", () => {
  it("sends a decimal string checksum and reads the provider's decimal string response", async () => {
    const plaintext = new Uint8Array([9, 8, 7]);
    const aad = new Uint8Array([4]);
    const requests: string[] = [];
    const transport = createGcpKmsHttpsTransport({
      bearerToken: "fixture-token",
      fetchImpl: async (_input, init) => {
        requests.push(String(init?.body));
        return Response.json({
          name: KEY_VERSION,
          ciphertext: bytesToB64(CIPHERTEXT),
          ciphertextCrc32c: crc32cDecimalString(CIPHERTEXT),
          verifiedPlaintextCrc32c: true,
        });
      },
    });

    const response = await transport.encrypt({
      keyName: KEY_NAME,
      plaintext,
      aad,
    });

    expect(requests).toEqual([
      JSON.stringify({
        plaintext: bytesToB64(plaintext),
        plaintextCrc32c: crc32cDecimalString(plaintext),
        additionalAuthenticatedData: bytesToB64(aad),
      }),
    ]);
    expect(response).toEqual({
      ciphertext: CIPHERTEXT,
      keyVersionName: KEY_VERSION,
      ciphertextCrc32c: crc32cDecimalString(CIPHERTEXT),
      verifiedPlaintextCrc32c: true,
    });
  });

  it.each([undefined, null, "", 0, { value: "0" }])(
    "refuses missing or non-string REST checksums: %j",
    async (checksum) => {
      const transport = createGcpKmsHttpsTransport({
        bearerToken: "fixture-token",
        fetchImpl: async () =>
          Response.json({
            name: KEY_VERSION,
            ciphertext: bytesToB64(CIPHERTEXT),
            ciphertextCrc32c: checksum,
            plaintext: bytesToB64(CIPHERTEXT),
            plaintextCrc32c: checksum,
            verifiedPlaintextCrc32c: true,
          }),
      });

      await expect(
        transport.encrypt({
          keyName: KEY_NAME,
          plaintext: CIPHERTEXT,
          aad: new Uint8Array(),
        }),
      ).rejects.toMatchObject({ code: "provider_denied" });
      await expect(
        transport.decrypt({
          keyName: KEY_NAME,
          ciphertext: CIPHERTEXT,
          aad: new Uint8Array(),
        }),
      ).rejects.toMatchObject({ code: "provider_denied" });
    },
  );

  it.each([
    { reason: "checksum mismatch", checksum: "0", verified: true },
    {
      reason: "unverified plaintext",
      checksum: crc32cDecimalString(CIPHERTEXT),
      verified: false,
    },
  ])(
    "refuses a REST encrypt response with $reason",
    async ({ checksum, verified }) => {
      const transport = createGcpKmsHttpsTransport({
        bearerToken: "fixture-token",
        fetchImpl: async () =>
          Response.json({
            name: KEY_VERSION,
            ciphertext: bytesToB64(CIPHERTEXT),
            ciphertextCrc32c: checksum,
            verifiedPlaintextCrc32c: verified,
          }),
      });
      const protector = createGcpKmsProtector({
        transport,
        authorization: "authorized",
      });

      await expect(
        protector.wrap({
          context: CONTEXT,
          rootKey: mintWrappingSecret(),
          keyName: KEY_NAME,
          connectionId: "conn-1",
          connectionConfigVersion: "1",
        }),
      ).rejects.toMatchObject({ code: "provider_denied" });
    },
  );

  it("refuses a REST decrypt response whose plaintext checksum does not match", async () => {
    let held = "";
    const transport = createGcpKmsHttpsTransport({
      bearerToken: "fixture-token",
      fetchImpl: async (input, init) => {
        if (String(input).endsWith(":encrypt")) {
          const body: BoundaryValue = JSON.parse(String(init?.body));
          if (!isJsonObject(body) || !isString(body.plaintext))
            throw new Error("Missing fixture plaintext.");
          held = body.plaintext;
          return Response.json({
            name: KEY_VERSION,
            ciphertext: bytesToB64(CIPHERTEXT),
            ciphertextCrc32c: crc32cDecimalString(CIPHERTEXT),
            verifiedPlaintextCrc32c: true,
          });
        }
        const wrongChecksum =
          crc32cDecimalString(b64ToBytes(held)) === "0" ? "1" : "0";
        return Response.json({
          plaintext: held,
          plaintextCrc32c: wrongChecksum,
        });
      },
    });
    const protector = createGcpKmsProtector({
      transport,
      authorization: "authorized",
    });
    const { record } = await protector.wrap({
      context: CONTEXT,
      rootKey: mintWrappingSecret(),
      keyName: KEY_NAME,
      connectionId: "conn-1",
      connectionConfigVersion: "1",
    });

    await expect(
      protector.unwrap({ context: CONTEXT, record }),
    ).rejects.toMatchObject({ code: "provider_denied" });
  });
});

describe("GCP KMS symmetric decrypt resource", () => {
  it("opens captured ciphertext after primary rotation through the documented CryptoKey endpoint", async () => {
    const held = new Map<string, string>();
    let primaryVersion = KEY_VERSION;
    const decryptRequests: string[] = [];
    const transport = createGcpKmsHttpsTransport({
      bearerToken: "fixture-token",
      fetchImpl: async (input, init) => {
        const endpoint = String(input);
        const body: BoundaryValue = JSON.parse(String(init?.body));
        if (!isJsonObject(body)) throw new Error("Expected fixture request.");
        if (
          endpoint === `https://cloudkms.googleapis.com/v1/${KEY_NAME}:encrypt`
        ) {
          if (!isString(body.plaintext)) throw new Error("Missing plaintext.");
          const ciphertext = bytesToB64(
            crypto.getRandomValues(new Uint8Array(40)),
          );
          held.set(ciphertext, body.plaintext);
          return Response.json({
            name: primaryVersion,
            ciphertext,
            ciphertextCrc32c: crc32cDecimalString(b64ToBytes(ciphertext)),
            verifiedPlaintextCrc32c: true,
          });
        }
        if (
          endpoint !== `https://cloudkms.googleapis.com/v1/${KEY_NAME}:decrypt`
        )
          return new Response("Unsupported resource.", { status: 404 });
        decryptRequests.push(String(init?.body));
        if (!isString(body.ciphertext)) throw new Error("Missing ciphertext.");
        const plaintext = held.get(body.ciphertext);
        if (!plaintext)
          return new Response("Unknown ciphertext.", { status: 400 });
        return Response.json({
          plaintext,
          plaintextCrc32c: crc32cDecimalString(b64ToBytes(plaintext)),
          usedPrimary: primaryVersion === KEY_VERSION,
        });
      },
    });
    const protector = createGcpKmsProtector({
      transport,
      authorization: "authorized",
    });
    const rootKey = mintWrappingSecret();
    const { record } = await protector.wrap({
      context: CONTEXT,
      rootKey,
      keyName: KEY_NAME,
      connectionId: "conn-1",
      connectionConfigVersion: "1",
    });
    expect(record.keyVersionName).toBe(KEY_VERSION);
    primaryVersion = `${KEY_NAME}/cryptoKeyVersions/2`;

    await expect(
      protector.unwrap({ context: CONTEXT, record }),
    ).resolves.toEqual(rootKey);

    expect(record.keyVersionName).toBe(KEY_VERSION);
    expect(decryptRequests).toEqual([
      JSON.stringify({
        ciphertext: record.wrappedSecretB64,
        additionalAuthenticatedData: record.aadB64,
      }),
    ]);
    held.clear();
    await expect(
      protector.unwrap({ context: CONTEXT, record }),
    ).rejects.toMatchObject({ code: "provider_denied" });
    expect(decryptRequests).toHaveLength(2);
    expect(decryptRequests[1]).toBe(decryptRequests[0]);
  });

  it.each([
    "not-a-key-version",
    "projects/other/locations/global/keyRings/r/cryptoKeys/k/cryptoKeyVersions/1",
  ])("refuses an invalid captured version before HTTP: %s", async (version) => {
    const requests: string[] = [];
    const transport = createGcpKmsHttpsTransport({
      bearerToken: "fixture-token",
      fetchImpl: async (input) => {
        requests.push(String(input));
        return Response.json({});
      },
    });

    await expect(
      transport.decrypt({
        keyName: KEY_NAME,
        expectedKeyVersionName: version,
        ciphertext: CIPHERTEXT,
        aad: new Uint8Array(),
      }),
    ).rejects.toMatchObject({ code: "malformed_encoding" });

    expect(requests).toEqual([]);
  });
});
