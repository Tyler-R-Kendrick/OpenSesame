/**
 * A static shared chunk for the credential model's runtime dependency closure.
 * The account definitions depend on JSON helpers; binding and splitting depend
 * on the credential definitions. Keeping those five modules together avoids a
 * static dependency back into main. No crypto, storage, reader or optional
 * capability belongs to this boundary.
 */
const MODEL_MODULE =
  /\/packages\/(?:vault-core\/src\/(?:account|credential|credential-bind|credential-split)|os-domain\/src\/json)\.[jt]s$/;

export function credentialModelChunk(id) {
  if (
    id.startsWith("virtual:") ||
    id.includes("\0") ||
    id.includes("?") ||
    id.includes("#")
  )
    return undefined;
  return MODEL_MODULE.test(id.replace(/\\/g, "/"))
    ? "shared-credential-model"
    : undefined;
}
