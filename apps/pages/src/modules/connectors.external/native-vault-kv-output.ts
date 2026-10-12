/** Both Vault authentication methods return secret fields through the same masked display contract. */
import { type BoundaryObject, isString } from "@opensesame/os-domain";

export function nativeVaultSecretItems(data: BoundaryObject) {
  const entries = Object.entries(data);
  if (entries.length > 64)
    throw new Error("This secret contains more than 64 fields");
  return entries.map(([id, value]) => {
    const secretValue = isString(value) ? value : JSON.stringify(value);
    if (
      !id ||
      id.length > 256 ||
      secretValue === undefined ||
      secretValue.length > 32768
    )
      throw new Error("This secret field exceeds the display limit");
    return { id, label: id, secretValue };
  });
}
