/** Opaque id helpers for vault/root/protector scopes. */

export function newOpaqueId(prefix: string): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  let hex = "";
  for (const byte of bytes) hex += byte.toString(16).padStart(2, "0");
  return `${prefix}_${hex}`;
}

export function newVaultId(): string {
  return newOpaqueId("vault");
}

export function newRootKeyId(): string {
  return newOpaqueId("root");
}

export function newProtectorId(kind: string): string {
  return newOpaqueId(kind.replace(/[^a-z0-9-]/gi, ""));
}
