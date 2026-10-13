/** Browser physical ciphertext producers. They issue DATA only, never owner or factors-complete authority. */
import { createOriginalOriginStorageProfile } from "../lib/original-origin-storage.js";
import type { PhysicalAuthenticationPort } from "../lib/vault/physical-authentication-port.js";
import type { PhysicalAuthenticationSnapshot } from "../lib/vault/physical-authentication-port.js";
import type {
  PhysicalCurrentCredentialCataloguePort,
  PhysicalCurrentCredentialCatalogueReader,
  PhysicalCurrentCredentialCatalogueSnapshot,
  PhysicalCurrentCredentialScope,
  PhysicalCurrentCredentialScopeReader,
  PhysicalCurrentCredentialScopeSnapshot,
} from "../lib/vault/physical-current-credential-catalogue.js";
import type { PhysicalDeviceRecordPort } from "../lib/vault/physical-device-record-port.js";
import type { PhysicalVaultPublicationPort } from "../lib/vault/physical-vault-publication-port.js";
import {
  readBrowserPhysicalRegistryData,
  readBrowserPhysicalTombData,
} from "./physical-vault-name-data.js";

const HEADER_BOUND = 65536;
const BODY_BOUND = 8 << 20;
function unavailable(): never {
  throw new Error("Original browser vault state is unavailable.");
}
function tombKey(
  tomb: string,
  path: "header" | "body" | "retired-credentials.v2",
) {
  return `tomb/${readBrowserPhysicalTombData(tomb)}/${path}`;
}
function deviceKey(key: string): string {
  if (
    !/^tomb\/[A-Za-z0-9][A-Za-z0-9._-]{0,199}\/retired-credentials\.v2$/u.test(
      key,
    ) &&
    !/^opensesame-private\/agent-canaries\/[a-f0-9]{64}\.v1$/u.test(key)
  )
    unavailable();
  return key;
}
/** Created by each original browser host; every producer shares its private captured native profile. */
export function createBrowserPhysicalVaultPorts() {
  const capture = createOriginalOriginStorageProfile();
  return Object.freeze({
    physicalVaultAuthentication: authenticationPort(capture),
    physicalDeviceRecords: deviceRecordPort(capture),
    physicalCurrentCredentialCatalogue: cataloguePort(capture),
    physicalVaultPublication: publicationPort(capture),
  });
}
type OriginCapture = ReturnType<typeof createOriginalOriginStorageProfile>;
function authenticationPort(
  capture: OriginCapture,
): PhysicalAuthenticationPort {
  return Object.freeze({
    bodyFormat: "flat-v1",
    async capture(tomb, original) {
      readBrowserPhysicalTombData(tomb);
      const source = await capture(original);
      return Object.freeze({
        check: source.check,
        close: source.close,
        revalidateRoot: source.revalidateRoot,
        readOriginalStateIdentity: source.readOriginalStateIdentity,
        async read() {
          const header = await source.read(
            tombKey(tomb, "header"),
            HEADER_BOUND,
          );
          const body = await source.read(tombKey(tomb, "body"), BODY_BOUND);
          source.check();
          return Object.freeze({ tomb, header, body });
        },
      });
    },
  });
}
function deviceRecordPort(capture: OriginCapture): PhysicalDeviceRecordPort {
  return Object.freeze({
    async capture(original) {
      const source = await capture(original);
      return Object.freeze({
        check: source.check,
        close: source.close,
        revalidateRoot: source.revalidateRoot,
        readOriginalStateIdentity: source.readOriginalStateIdentity,
        read: (key, bound) => source.read(deviceKey(key), bound),
        async captureRetiredCredentialInventory() {
          const inventory = [];
          const wire = await source.read("tombs.v1", 32768);
          for (const tomb of readBrowserPhysicalRegistryData(wire)) {
            const record = await source.readRecord(
              tombKey(tomb, "retired-credentials.v2"),
              32768,
            );
            if (record.value !== null) {
              if (record.ciphertextDigest === null) unavailable();
              inventory.push(
                Object.freeze({
                  tomb,
                  wire: record.value,
                  physicalName: record.physicalName,
                  ciphertextDigest: record.ciphertextDigest,
                }),
              );
            }
          }
          if ((await source.read("tombs.v1", 32768)) !== wire) unavailable();
          source.check();
          return Object.freeze(inventory);
        },
        publish: (key, expected, next, bound, publicationCheck) =>
          source.publish(
            deviceKey(key),
            expected,
            next,
            bound,
            publicationCheck,
          ),
      });
    },
  });
}
function cataloguePort(
  capture: OriginCapture,
): PhysicalCurrentCredentialCataloguePort {
  return Object.freeze({
    async capture(original) {
      const source = await capture(original);
      const wire = await source.read("tombs.v1", 32768);
      const identity = await source.readOriginalStateIdentity();
      const scopes = Object.freeze(
        readBrowserPhysicalRegistryData(wire).map((tomb) =>
          Object.freeze({
            tomb,
            physicalIdentity: `${identity}:${tomb}`,
          }),
        ),
      );
      const issued = new Set<PhysicalCurrentCredentialScope>(scopes);
      const snapshot = Object.freeze({ physicalIdentity: identity, scopes });
      const revalidate = async (
        expected: PhysicalCurrentCredentialCatalogueSnapshot,
      ) => {
        source.check();
        if (expected !== snapshot) unavailable();
        if ((await source.read("tombs.v1", 32768)) !== wire) unavailable();
        await source.revalidateRoot();
        source.check();
      };
      const reader: PhysicalCurrentCredentialCatalogueReader = {
        check: source.check,
        close: source.close,
        async read() {
          await revalidate(snapshot);
          return snapshot;
        },
        revalidate,
        async captureScope(
          scope: PhysicalCurrentCredentialScope,
          scopeOriginal: () => void,
        ) {
          if (!issued.has(scope)) unavailable();
          await revalidate(snapshot);
          return captureCatalogueScope(
            capture,
            source,
            scope,
            scopeOriginal,
            () => revalidate(snapshot),
          );
        },
      };
      return Object.freeze(reader);
    },
  });
}
function publicationPort(capture: OriginCapture): PhysicalVaultPublicationPort {
  return Object.freeze({
    async capture(tomb, original) {
      readBrowserPhysicalTombData(tomb);
      const source = await capture(original);
      const read = async () => {
        const header = await source.read(tombKey(tomb, "header"), HEADER_BOUND);
        const body = await source.read(tombKey(tomb, "body"), BODY_BOUND);
        return Object.freeze({ tomb, header, body });
      };
      const revalidate = async (expected: PhysicalAuthenticationSnapshot) => {
        const current = await read();
        if (
          expected.tomb !== tomb ||
          expected.header !== current.header ||
          expected.body !== current.body
        )
          unavailable();
        source.check();
        return current;
      };
      return Object.freeze({
        check: source.check,
        close: source.close,
        collectProjection: (expected) => revalidate(expected),
        async publishProjection() {
          unavailable(); // The browser already stores the original flat ciphertext; no Node projection fallback.
        },
        async publishHeader(expected, next, publicationCheck) {
          await revalidate(expected);
          publicationCheck?.();
          await source.publish(
            tombKey(tomb, "header"),
            expected.header,
            next,
            HEADER_BOUND,
            publicationCheck,
          );
          if (
            (await source.read(tombKey(tomb, "body"), BODY_BOUND)) !==
            expected.body
          )
            unavailable();
          const current = await read();
          if (current.header !== next) unavailable();
          publicationCheck?.();
          source.check();
          return current;
        },
      });
    },
  });
}

async function captureCatalogueScope(
  capture: OriginCapture,
  source: Awaited<ReturnType<OriginCapture>>,
  scope: PhysicalCurrentCredentialScope,
  scopeOriginal: () => void,
  revalidateCatalogue: () => Promise<void>,
): Promise<PhysicalCurrentCredentialScopeReader> {
  const local = await capture(() => {
    source.check();
    scopeOriginal();
  });
  let selected: PhysicalCurrentCredentialScopeSnapshot | undefined;
  const reader: PhysicalCurrentCredentialScopeReader = {
    check: local.check,
    close: local.close,
    async read() {
      const header = await local.read(
        tombKey(scope.tomb, "header"),
        HEADER_BOUND,
      );
      const body = await local.read(tombKey(scope.tomb, "body"), BODY_BOUND);
      if (header === null || body === null) unavailable();
      selected = Object.freeze({
        ...scope,
        kind: "legacy",
        bodyFormat: "flat-v1",
        header,
        body,
      });
      local.check();
      return selected;
    },
    async revalidate(expected: PhysicalCurrentCredentialScopeSnapshot) {
      if (expected !== selected || expected.kind !== "legacy") unavailable();
      if (
        (await local.read(tombKey(scope.tomb, "header"), HEADER_BOUND)) !==
        expected.header
      )
        unavailable();
      if (
        (await local.read(tombKey(scope.tomb, "body"), BODY_BOUND)) !==
        expected.body
      )
        unavailable();
      await revalidateCatalogue();
      await local.revalidateRoot();
      local.check();
    },
  };
  return Object.freeze(reader);
}
