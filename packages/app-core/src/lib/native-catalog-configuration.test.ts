import { generateKeyPairSync } from "node:crypto";
import { sha256 } from "@noble/hashes/sha2";
import { bytesToHex } from "@noble/hashes/utils";
import { canonicalize, overlapCast } from "@opensesame/os-domain";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { configureHost } from "../host.js";
import { createTestHost } from "../test-host.js";
import { webLocksDouble } from "./__tests__/web-locks-double.js";
import { isSealedAtRest } from "./at-rest/cipher.js";
import { forgetAtRestKeyForTest } from "./at-rest/key.js";
import {
  DEVICE_CONNECTOR_KEYS,
  readDeviceRows,
} from "./device-connector-records.js";
import { kvFlush, kvForgetAll, kvHydrate } from "./kv.js";
import {
  configureNativeCatalogConfiguration,
  nativeCatalogConfiguration,
  readNativeCatalogConfiguration,
  verifyNativeCatalogConfiguration,
} from "./native-catalog-configuration.js";
import type { NativeDriverInput } from "./native-connector-drivers.js";
import {
  loadNativeConnectorRecord,
  readNativeConnector,
  updateNativeConnector,
} from "./native-connector-store.js";
import type { NativeProviderTransport } from "./native-connector-transport.js";

function walletKey(): string {
  return generateKeyPairSync("rsa", { modulusLength: 2048 })
    .privateKey.export({
      type: "pkcs8",
      format: "pem",
    })
    .toString();
}
const secret = walletKey();
const secondSecret = walletKey();
const input: NativeDriverInput = {
  providerId: "google-wallet",
  method: "native-local",
  displayName: "Synthetic Wallet",
  icon: "",
  parameters: {
    issuer_id: "1234567890",
    class_id: "synthetic-class",
    service_account_email: "synthetic@example.invalid",
  },
  credentials: { service_account_key: secret },
  requestedScopes: {},
  targetIds: {},
};

function encryptedDisk() {
  const files = new Map<string, string>();
  return {
    files,
    async getFileHandle(name: string, options?: { create?: boolean }) {
      if (!files.has(name)) {
        if (!options?.create)
          throw new DOMException("Missing", "NotFoundError");
        files.set(name, "");
      }
      return {
        async getFile() {
          const text = files.get(name) ?? "";
          return { size: text.length, text: async () => text };
        },
        async createWritable() {
          let staged = files.get(name) ?? "";
          return {
            async write(value: string) {
              staged = value;
            },
            async close() {
              files.set(name, staged);
            },
            async abort() {},
          };
        },
      };
    },
  };
}

let disk: ReturnType<typeof encryptedDisk>;
let transport: NativeProviderTransport;
let fetcher: ReturnType<typeof vi.fn<typeof fetch>>;

beforeEach(() => {
  kvForgetAll();
  forgetAtRestKeyForTest();
  disk = encryptedDisk();
  configureHost(
    createTestHost({
      originFiles: async () => overlapCast(disk),
      locks: overlapCast(webLocksDouble()),
    }),
  );
  fetcher = vi.fn<typeof fetch>();
  transport = { fetch: fetcher, assertCurrent: () => {} };
});

afterEach(() => {
  kvForgetAll();
  forgetAtRestKeyForTest();
  configureHost(createTestHost());
  vi.restoreAllMocks();
});

async function coldReload() {
  await kvFlush();
  kvForgetAll();
  forgetAtRestKeyForTest();
  await kvHydrate([...DEVICE_CONNECTOR_KEYS]);
}

it("seals catalog secrets and survives the store's encrypted cold reload without provider requests", async () => {
  const saved = await configureNativeCatalogConfiguration(input, transport);
  expect(saved.status).toBe("connected");
  expect(saved.configuration.parameters).toEqual(input.parameters);
  expect(saved.identity).toMatchObject({
    kind: "configuration",
    assurance: "credential-valid",
  });
  expect(
    loadNativeConnectorRecord(saved.connectionId)?.privateState.verification
      ?.kind,
  ).toBe("configuration");
  expect(JSON.stringify(readDeviceRows())).not.toContain(secret);
  expect(JSON.stringify(saved)).not.toContain(secret);
  expect([...disk.files.values()].join()).not.toContain(secret);
  const sealedFiles = [...disk.files.values()].filter(Boolean);
  expect(sealedFiles.length).toBeGreaterThan(0);
  expect(sealedFiles.every(isSealedAtRest)).toBe(true);

  await coldReload();
  expect(readNativeConnector(saved.connectionId)).toEqual(saved);
  const verified = await verifyNativeCatalogConfiguration(
    saved.connectionId,
    transport,
  );
  expect(verified.status).toBe("connected");
  const reviewed = await readNativeCatalogConfiguration(
    saved.connectionId,
    {},
    transport,
  );
  expect(reviewed.items).toContainEqual({
    id: "status",
    label: "Configuration verified locally; provider access was not checked",
  });
  expect(JSON.stringify(reviewed)).not.toContain(secret);
  expect(reviewed.items).toContainEqual({
    id: "issuer_id",
    label: "Issuer id: 1234567890",
  });
  expect(fetcher).not.toHaveBeenCalled();
});

it("retains the sealed key on edit and enforces revision and fingerprint guards", async () => {
  const saved = await configureNativeCatalogConfiguration(input, transport);
  const renamed = await configureNativeCatalogConfiguration(
    {
      ...input,
      connectionId: saved.connectionId,
      revision: saved.revision,
      displayName: "Renamed Wallet",
      credentials: { service_account_key: "" },
    },
    transport,
  );
  expect(renamed.status).toBe("connected");
  expect(
    loadNativeConnectorRecord(saved.connectionId)?.privateState.credentials
      .service_account_key,
  ).toBe(secret);

  await expect(
    configureNativeCatalogConfiguration(
      {
        ...input,
        connectionId: saved.connectionId,
        revision: saved.revision,
      },
      transport,
    ),
  ).rejects.toThrow("changed; reload");

  await updateNativeConnector(
    saved.connectionId,
    renamed,
    nativeCatalogConfiguration("google-wallet")?.classification ?? {
      publicParameters: [],
      privateCredentials: [],
    },
    (record) => {
      record.configuration.fingerprint = "f".repeat(64);
      return record;
    },
  );
  await expect(
    readNativeCatalogConfiguration(saved.connectionId, {}, transport),
  ).rejects.toThrow("binding changed");
  expect(fetcher).not.toHaveBeenCalled();
});

it("validates fields locally and admits only complete configuration-only catalog contracts", async () => {
  expect(nativeCatalogConfiguration("google-wallet")?.classification).toEqual({
    publicParameters: ["issuer_id", "class_id", "service_account_email"],
    privateCredentials: ["service_account_key"],
  });
  expect(nativeCatalogConfiguration("google")).toBeNull();
  expect(nativeCatalogConfiguration("apple-wallet")).toBeNull();
  expect(nativeCatalogConfiguration("samsung-wallet")).toBeNull();
  expect(nativeCatalogConfiguration("vault")).toBeNull();
  expect(nativeCatalogConfiguration("unknown-provider")).toBeNull();
  await expect(
    configureNativeCatalogConfiguration(
      { ...input, parameters: { ...input.parameters, issuer_id: " " } },
      transport,
    ),
  ).rejects.toThrow("Enter issuer id");
  await expect(
    configureNativeCatalogConfiguration(
      { ...input, parameters: { ...input.parameters, unexpected: "value" } },
      transport,
    ),
  ).rejects.toThrow("unsupported configuration field");
  await expect(
    configureNativeCatalogConfiguration(
      {
        ...input,
        parameters: {
          ...input.parameters,
          service_account_key: "must-not-be-public",
        },
        credentials: {},
      },
      transport,
    ),
  ).rejects.toThrow("must remain sealed");
  expect(readDeviceRows()).toEqual([]);
  expect(fetcher).not.toHaveBeenCalled();
});

it("does not derive a public fingerprint from secret values", async () => {
  const first = await configureNativeCatalogConfiguration(
    { ...input, credentials: { service_account_key: secret } },
    transport,
  );
  const second = await configureNativeCatalogConfiguration(
    { ...input, credentials: { service_account_key: secondSecret } },
    transport,
  );
  expect(first.configuration.fingerprint).toBe(
    second.configuration.fingerprint,
  );
  expect(first.configuration.fingerprint).toBe(
    bytesToHex(
      sha256(
        new TextEncoder().encode(
          canonicalize({
            providerId: input.providerId,
            parameters: input.parameters,
          }),
        ),
      ),
    ),
  );
  expect(first.configuration.fingerprint).not.toBe(
    bytesToHex(
      sha256(
        new TextEncoder().encode(
          canonicalize({
            providerId: input.providerId,
            parameters: input.parameters,
            credentials: input.credentials,
          }),
        ),
      ),
    ),
  );
});

it.each([
  ["issuer_id", "not-numeric"],
  ["class_id", "not a class"],
  ["class_id", "999999.pass"],
  ["service_account_email", "not-an-email"],
])(
  "rejects malformed %s without saving or making a request",
  async (field, value) => {
    await expect(
      configureNativeCatalogConfiguration(
        { ...input, parameters: { ...input.parameters, [field]: value } },
        transport,
      ),
    ).rejects.toThrow();
    expect(readDeviceRows()).toEqual([]);
    expect(fetcher).not.toHaveBeenCalled();
  },
);

it("rejects a key that is not a valid PKCS#8 RSA private key", async () => {
  await expect(
    configureNativeCatalogConfiguration(
      { ...input, credentials: { service_account_key: "not-a-private-key" } },
      transport,
    ),
  ).rejects.toThrow();
  expect(readDeviceRows()).toEqual([]);
  expect(fetcher).not.toHaveBeenCalled();
});

it.each(["issuer_id", "class_id", "service_account_email"])(
  "refuses a credential duplicated into public %s",
  async (field) => {
    await expect(
      configureNativeCatalogConfiguration(
        { ...input, parameters: { ...input.parameters, [field]: secret } },
        transport,
      ),
    ).rejects.toMatchObject({ code: "response" });
    expect(readDeviceRows()).toEqual([]);
    expect(fetcher).not.toHaveBeenCalled();
  },
);

it("refuses to render a legacy public value containing the sealed credential", async () => {
  const saved = await configureNativeCatalogConfiguration(input, transport);
  const parameters = { ...input.parameters, class_id: secret };
  const fingerprint = bytesToHex(
    sha256(
      new TextEncoder().encode(
        canonicalize({ providerId: input.providerId, parameters }),
      ),
    ),
  );
  await updateNativeConnector(
    saved.connectionId,
    saved,
    nativeCatalogConfiguration("google-wallet")?.classification ?? {
      publicParameters: [],
      privateCredentials: [],
    },
    (record) => {
      record.configuration.parameters = parameters;
      record.configuration.fingerprint = fingerprint;
      if (record.privateState.verification)
        record.privateState.verification.fingerprint = fingerprint;
      return record;
    },
  );
  await expect(
    readNativeCatalogConfiguration(saved.connectionId, {}, transport),
  ).rejects.toMatchObject({ code: "response" });
  expect(fetcher).not.toHaveBeenCalled();
});
