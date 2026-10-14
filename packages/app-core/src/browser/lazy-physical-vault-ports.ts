/** Fixed lazy browser transport DATA; callback cancels but cannot issue locks, factors, Root or REAL. */
import { host } from "../host.js";
import { atRestSettled } from "../lib/at-rest/key.js";
import type { PhysicalAuthenticationPort } from "../lib/vault/physical-authentication-port.js";
import type { PhysicalCurrentCredentialCataloguePort } from "../lib/vault/physical-current-credential-catalogue.js";
import type { PhysicalDeviceRecordPort } from "../lib/vault/physical-device-record-port.js";
import type { PhysicalVaultPublicationPort } from "../lib/vault/physical-vault-publication-port.js";
import { originFiles } from "../ports.js";
import { readBrowserPhysicalTombData } from "./physical-vault-name-data.js";
type OriginalFamily = ReturnType<
  typeof import("./physical-vault-ports.js").createBrowserPhysicalVaultPorts
>;
function unavailable(): never {
  throw new Error("Original browser vault state is unavailable.");
}
function sameDescriptor(
  current: PropertyDescriptor | undefined,
  original: PropertyDescriptor | undefined,
): boolean {
  return (
    current?.value === original?.value &&
    current?.get === original?.get &&
    current?.set === original?.set
  );
}
/** Native provider/root capture remains in the actual producer; retain the preceding caller/Host/key boundary across module loading. */
function originalImportGuard(original: () => void) {
  original();
  const installed = host();
  const provider = originFiles();
  const settled = atRestSettled();
  const keys = installed.atRestKeys;
  const originDescriptor = Object.getOwnPropertyDescriptor(
    installed,
    "originFiles",
  );
  const keyDescriptor = Object.getOwnPropertyDescriptor(
    installed,
    "atRestKeys",
  );
  return () => {
    original();
    if (
      host() !== installed ||
      originFiles() !== provider ||
      atRestSettled() !== settled ||
      installed.atRestKeys !== keys ||
      !sameDescriptor(
        Object.getOwnPropertyDescriptor(installed, "originFiles"),
        originDescriptor,
      ) ||
      !sameDescriptor(
        Object.getOwnPropertyDescriptor(installed, "atRestKeys"),
        keyDescriptor,
      )
    )
      unavailable();
    original();
  };
}
/** One fixed module/factory instance per original browser host, shared by all four ports. No caller loader/producer argument. */
export function createLazyBrowserPhysicalVaultPorts() {
  let loading: Promise<OriginalFamily> | undefined;
  const family = async (original: () => void) => {
    const check = originalImportGuard(original);
    check();
    loading ??= import("./physical-vault-ports.js").then((module) =>
      module.createBrowserPhysicalVaultPorts(),
    );
    const ports = await loading;
    check();
    return { ports, check };
  };
  const authentication: PhysicalAuthenticationPort = Object.freeze({
    bodyFormat: "flat-v1",
    async capture(tomb: string, original: () => void) {
      const selected = readBrowserPhysicalTombData(tomb);
      const captured = await family(original);
      // Return the actual producer's Promise directly: no new post-delivery resource owner or cleanup hop.
      return captured.ports.physicalVaultAuthentication.capture(
        selected,
        captured.check,
      );
    },
  });
  const device: PhysicalDeviceRecordPort = Object.freeze({
    async capture(original: () => void) {
      const captured = await family(original);
      return captured.ports.physicalDeviceRecords.capture(captured.check);
    },
  });
  const catalogue: PhysicalCurrentCredentialCataloguePort = Object.freeze({
    async capture(original: () => void) {
      const captured = await family(original);
      return captured.ports.physicalCurrentCredentialCatalogue.capture(
        captured.check,
      );
    },
  });
  const publication: PhysicalVaultPublicationPort = Object.freeze({
    async capture(tomb: string, original: () => void) {
      const selected = readBrowserPhysicalTombData(tomb);
      const captured = await family(original);
      return captured.ports.physicalVaultPublication.capture(
        selected,
        captured.check,
      );
    },
  });
  return Object.freeze({
    physicalVaultAuthentication: authentication,
    physicalDeviceRecords: device,
    physicalCurrentCredentialCatalogue: catalogue,
    physicalVaultPublication: publication,
  });
}
