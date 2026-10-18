import type {
  PhysicalCurrentCredentialCatalogueReader,
  PhysicalCurrentCredentialScopeReader,
} from "./physical-current-credential-catalogue.js";
/** Reader method identity only; a matching reader never proves authentication. */
import type { PhysicalDeviceRecordReader } from "./physical-device-record-port.js";
import type { PhysicalVaultPublicationReader } from "./physical-vault-publication-port.js";
function changed(): never {
  throw new Error("Original physical reader methods changed.");
}
export function captureRetiredDeviceReaderIdentity(
  reader: PhysicalDeviceRecordReader,
) {
  const {
    read,
    publish,
    check,
    close,
    revalidateRoot,
    readOriginalStateIdentity,
    captureRetiredCredentialInventory,
    readLegacy,
    captureLegacyInventory,
  } = reader;
  return () => {
    if (
      reader.read !== read ||
      reader.publish !== publish ||
      reader.check !== check ||
      reader.close !== close ||
      reader.revalidateRoot !== revalidateRoot ||
      reader.readOriginalStateIdentity !== readOriginalStateIdentity ||
      reader.captureRetiredCredentialInventory !==
        captureRetiredCredentialInventory ||
      reader.readLegacy !== readLegacy ||
      reader.captureLegacyInventory !== captureLegacyInventory
    )
      changed();
  };
}
export function captureRetiredPublicationReaderIdentity(
  reader: PhysicalVaultPublicationReader,
) {
  const { collectProjection, publishProjection, publishHeader, check, close } =
    reader;
  return () => {
    if (
      reader.collectProjection !== collectProjection ||
      reader.publishProjection !== publishProjection ||
      reader.publishHeader !== publishHeader ||
      reader.check !== check ||
      reader.close !== close
    )
      changed();
  };
}
export function captureRetiredCatalogueReaderIdentity(
  reader: PhysicalCurrentCredentialCatalogueReader,
) {
  const { read, revalidate, captureScope, check, close } = reader;
  return () => {
    if (
      reader.read !== read ||
      reader.revalidate !== revalidate ||
      reader.captureScope !== captureScope ||
      reader.check !== check ||
      reader.close !== close
    )
      changed();
  };
}
export function captureRetiredScopeReaderIdentity(
  reader: PhysicalCurrentCredentialScopeReader,
) {
  const { read, revalidate, check, close } = reader;
  return () => {
    if (
      reader.read !== read ||
      reader.revalidate !== revalidate ||
      reader.check !== check ||
      reader.close !== close
    )
      changed();
  };
}
