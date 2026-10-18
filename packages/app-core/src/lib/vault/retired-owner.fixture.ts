/** Transport doubles with real primary/MAC/body/factor crypto; never native-browser evidence. */
import { isFunction, overlapCast } from "@opensesame/os-domain";
import {
  type VaultHeader,
  createVault,
  prepareFactorConfigurationBinding,
  sealJson,
  vaultSealBinding,
} from "@opensesame/vault-core";
import { configureHost, host } from "../../host.js";
import { createTestHost } from "../../test-host.js";
import { kvSet } from "../kv.js";
import type { PhysicalDeviceRecordReader } from "./physical-device-record-port.js";
import {
  manifestWithoutAuth,
  sealAuthenticatedManifest,
} from "./protection/manifest-auth.js";
import { migrateLegacyHeaderToManifest } from "./protection/migrate-legacy.js";
import { mintRecoveryCodes } from "./recovery-codes.js";
import { VaultStore } from "./store.js";
import { sealTotpSecret } from "./unlock-methods.js";

export const OWNER_PASSWORD = "real retired owner fixture security 53947";
export const OWNER_TOTP = "JBSWY3DPEHPK3PXP";
export async function retiredOwnerFixture(factors = false) {
  const previous = host();
  const created = await createVault(OWNER_PASSWORD);
  let header: VaultHeader = created.header;
  let recovery: string | undefined;
  if (factors) {
    const codes = await mintRecoveryCodes(created.vaultKey);
    recovery = codes.codes[0];
    header = {
      ...header,
      unlocks: {
        totp: await sealTotpSecret(created.vaultKey, OWNER_TOTP),
        recovery: codes.record,
      },
    };
  }
  header = {
    ...header,
    protection: migrateLegacyHeaderToManifest({
      header,
      vaultId: "retired-owner-vault",
      rootKeyId: "retired-owner-root",
      rootEpoch: 1,
      passkeyRpId: "owner.invalid",
    }).manifest,
  };
  if (!header.protection) throw new Error("Fixture manifest missing.");
  header = {
    ...header,
    protection: await sealAuthenticatedManifest(created.rawVaultKey, {
      ...manifestWithoutAuth(header.protection),
      factorConfiguration: await prepareFactorConfigurationBinding(header),
    }),
  };
  const body = JSON.stringify(
    await sealJson(
      created.vaultKey,
      { v: 1, rev: 0, items: [], folders: [] },
      vaultSealBinding("personal", "body"),
    ),
  );
  const transport = installRetiredOwnerFixturePorts(
    JSON.stringify(header),
    body,
  );
  const store = new VaultStore();
  return {
    store,
    ...transport,
    recovery,
    header,
    root: created.rawVaultKey,
    key: created.vaultKey,
    dispose: () => {
      store.lock();
      created.rawVaultKey.fill(0);
      configureHost(previous);
    },
  };
}

interface FixtureDisposalRefusals {
  close?: Error;
  release?: Error;
}
function installRetiredOwnerFixturePorts(initialHeader: string, body: string) {
  let headerText = initialHeader;
  kvSet("tomb/personal/header", headerText);
  kvSet("tomb/personal/body", body);
  const records = new Map<string, string>();
  const held: string[] = [];
  let closed = 0;
  let deliveredDevice: PhysicalDeviceRecordReader | undefined;
  const disposal: FixtureDisposalRefusals = {};
  let deviceReady!: () => void;
  const deviceCaptured = new Promise<void>((resolve) => {
    deviceReady = resolve;
  });
  const closeOriginal = async () => {
    closed++;
    if (disposal.close) throw disposal.close;
  };
  const locks = createRetiredFixtureLocks(held, () => disposal.release);
  const check = () => {
    if (!held.includes("opensesame.retired-credentials"))
      throw new Error("Fixture lost CRED.");
  };
  const identity = async () => "original-fixture-profile";
  const source = () => ({
    check,
    revalidateRoot: async () => check(),
    readOriginalStateIdentity: identity,
    close: closeOriginal,
  });
  const snapshot = () => ({ tomb: "personal", header: headerText, body });
  const original = createTestHost({
    locks,
    physicalVaultAuthentication: Object.freeze({
      bodyFormat: "flat-v1",
      capture: async () => ({ ...source(), read: async () => snapshot() }),
    }),
    physicalDeviceRecords: createRetiredFixtureDevicePort(
      records,
      check,
      source,
      (reader) => {
        deliveredDevice = reader;
        deviceReady();
      },
    ),
    physicalVaultPublication: Object.freeze({
      capture: async () => ({
        check,
        close: closeOriginal,
        collectProjection: async () => snapshot(),
        publishProjection: async () => {
          throw new Error("No fixture projection");
        },
        publishHeader: async (expected, next) => {
          if (expected.header !== headerText) throw new Error("Header changed");
          headerText = next;
          kvSet("tomb/personal/header", next);
          return snapshot();
        },
      }),
    }),
    physicalCurrentCredentialCatalogue: Object.freeze({
      capture: async () => ({
        check,
        close: closeOriginal,
        read: async () => ({
          physicalIdentity: "original-fixture-profile",
          scopes: [],
        }),
        revalidate: async () => check(),
        captureScope: async () => {
          throw new Error("No foreign fixture vault");
        },
      }),
    }),
  });
  configureHost(original);
  return {
    records,
    held,
    closed: () => closed,
    deviceReader: () => deliveredDevice,
    deviceCaptured,
    failCloses: (cause: Error | undefined) => {
      disposal.close = cause;
    },
    failCredentialRelease: (cause: Error | undefined) => {
      disposal.release = cause;
    },
    replaceHeader: (next: VaultHeader) => {
      headerText = JSON.stringify(next);
    },
  };
}

function createRetiredFixtureLocks(
  held: string[],
  releaseFailure: () => Error | undefined,
) {
  return overlapCast<unknown, LockManager>({
    async request<T>(
      name: string,
      options: { mode: string } | ((lock: Lock) => Promise<T>),
      work?: (lock: Lock) => Promise<T>,
    ) {
      held.push(name);
      let outcome: { value: T } | undefined;
      let failure: ErrorOptions | undefined;
      try {
        const callback = isFunction(options) ? options : work;
        if (!callback) throw new Error("Fixture lock callback is missing.");
        const mode =
          isFunction(options) || options.mode !== "shared"
            ? "exclusive"
            : "shared";
        outcome = { value: await callback({ name, mode }) };
      } catch (cause) {
        failure = { cause };
      }
      held.splice(held.lastIndexOf(name), 1);
      const release =
        name === "opensesame.retired-credentials"
          ? releaseFailure()
          : undefined;
      if (release) {
        if (failure)
          throw new AggregateError(
            [failure.cause, release],
            "Original callback and lease release failed.",
          );
        throw release;
      }
      if (failure) throw failure.cause;
      if (!outcome) throw new Error("Fixture lock result missing.");
      return outcome.value;
    },
  });
}

interface FixtureReaderLifetime {
  check: () => void;
  revalidateRoot: () => Promise<void>;
  readOriginalStateIdentity: () => Promise<string>;
  close: () => Promise<void>;
}
function createRetiredFixtureDevicePort(
  records: Map<string, string>,
  check: () => void,
  source: () => FixtureReaderLifetime,
  delivered: (reader: PhysicalDeviceRecordReader) => void,
) {
  return Object.freeze({
    capture: async () => {
      const reader = {
        ...source(),
        read: async (key: string) => records.get(key) ?? null,
        captureRetiredCredentialInventory: async () => {
          const wire = records.get("tomb/personal/retired-credentials.v2");
          return wire === undefined
            ? []
            : [
                {
                  tomb: "personal",
                  wire,
                  ciphertextDigest: [
                    ...new Uint8Array(
                      await crypto.subtle.digest(
                        "SHA-256",
                        new TextEncoder().encode(wire),
                      ),
                    ),
                  ]
                    .map((byte) => byte.toString(16).padStart(2, "0"))
                    .join(""),
                  physicalName: "fixture-native-record",
                },
              ];
        },
        publish: async (key: string, expected: string | null, next: string) => {
          check();
          if ((records.get(key) ?? null) !== expected)
            throw new Error("Fixture CAS changed.");
          records.set(key, next);
        },
      };
      delivered(reader);
      return reader;
    },
  });
}
