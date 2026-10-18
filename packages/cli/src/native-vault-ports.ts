import { authenticationPort } from "./native-vault-authentication.js";
import { cataloguePort } from "./native-vault-catalogue.js";
import { createNativeVaultContext } from "./native-vault-context.js";
import { devicePort } from "./native-vault-device.js";
import { publicationPort } from "./native-vault-publication.js";

export function createNativeVaultPorts(stateDir: string, executable?: string) {
  const context = createNativeVaultContext(stateDir, executable);
  return {
    locks: context.native.locks,
    physicalVaultAuthentication: authenticationPort(context),
    physicalDeviceRecords: devicePort(context),
    physicalCurrentCredentialCatalogue: cataloguePort(context),
    physicalVaultPublication: publicationPort(context),
  };
}
