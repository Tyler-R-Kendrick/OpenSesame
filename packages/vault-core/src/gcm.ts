import { overlapCast } from "@opensesame/os-domain";

const AES = "AES-GCM";

function aesParams(iv: Uint8Array, aad?: Uint8Array): AesGcmParams {
  const params: AesGcmParams = { name: AES, iv: overlapCast(iv) };
  if (aad) params.additionalData = overlapCast(aad);
  return params;
}

export async function gcmSeal(
  key: CryptoKey,
  plain: Uint8Array,
  iv: Uint8Array,
  aad?: Uint8Array,
): Promise<Uint8Array> {
  return new Uint8Array(
    await crypto.subtle.encrypt(aesParams(iv, aad), key, overlapCast(plain)),
  );
}

export async function gcmOpen(
  key: CryptoKey,
  iv: Uint8Array,
  body: Uint8Array,
  aad?: Uint8Array,
): Promise<Uint8Array> {
  return new Uint8Array(
    await crypto.subtle.decrypt(aesParams(iv, aad), key, overlapCast(body)),
  );
}
