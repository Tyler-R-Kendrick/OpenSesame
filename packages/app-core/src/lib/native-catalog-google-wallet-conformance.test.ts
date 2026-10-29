import { generateKeyPairSync } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { overlapCast } from "@opensesame/os-domain";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { configureHost } from "../host.js";
import { createTestHost } from "../test-host.js";
import { webLocksDouble } from "./__tests__/web-locks-double.js";
import { forgetAtRestKeyForTest } from "./at-rest/key.js";
import { kvForgetAll } from "./kv.js";
import { configureNativeCatalogConfiguration } from "./native-catalog-configuration.js";
import type { NativeDriverInput } from "./native-connector-drivers.js";
import type { NativeProviderTransport } from "./native-connector-transport.js";

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
  credentials: {
    service_account_key: generateKeyPairSync("rsa", { modulusLength: 2048 })
      .privateKey.export({ type: "pkcs8", format: "pem" })
      .toString(),
  },
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

it("replays shared Google Wallet public vectors through real configuration", async () => {
  const vectors = JSON.parse(
    readFileSync(
      fileURLToPath(
        new URL(
          "../../../../spec/conformance/google-wallet-configuration.json",
          import.meta.url,
        ),
      ),
      "utf8",
    ),
  );
  for (const item of vectors.public_cases) {
    const result = configureNativeCatalogConfiguration(
      {
        ...input,
        parameters: {
          issuer_id: item.issuer_id,
          class_id: item.class_id,
          service_account_email: item.service_account_email,
        },
      },
      transport,
    );
    if (item.native_entry_accepted ?? item.accepted)
      await expect(result, item.name).resolves.toMatchObject({
        status: "connected",
      });
    else await expect(result, item.name).rejects.toThrow();
  }
  expect(fetcher).not.toHaveBeenCalled();
});
