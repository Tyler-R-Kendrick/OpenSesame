/**
 * WAL-B18 — parent wrapping keys must not open child-sealed (or parent-sealed
 * under a different key) Wallet material.
 */

export async function generateWalletWrappingKey(): Promise<CryptoKey> {
  return crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, [
    "encrypt",
    "decrypt",
  ]);
}

export type SealedWalletMaterial = {
  readonly iv: Uint8Array;
  readonly ciphertext: Uint8Array;
};

export async function sealWalletMaterial(
  plaintext: Uint8Array,
  wrappingKey: CryptoKey,
): Promise<SealedWalletMaterial> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv },
      wrappingKey,
      plaintext,
    ),
  );
  return { iv, ciphertext };
}

export async function openWalletMaterial(
  sealed: SealedWalletMaterial,
  wrappingKey: CryptoKey,
): Promise<Uint8Array> {
  return new Uint8Array(
    await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: sealed.iv },
      wrappingKey,
      sealed.ciphertext,
    ),
  );
}
