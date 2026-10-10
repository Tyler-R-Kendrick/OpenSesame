/** Whether two vault keys are the same material (step-up confirmation). */
export async function vaultKeysMatch(
  left: CryptoKey,
  right: CryptoKey,
): Promise<boolean> {
  const [a, b] = await Promise.all([
    crypto.subtle.exportKey("raw", left),
    crypto.subtle.exportKey("raw", right),
  ]);
  if (a.byteLength !== b.byteLength) return false;
  const va = new Uint8Array(a);
  const vb = new Uint8Array(b);
  for (let i = 0; i < va.length; i++) {
    if (va[i] !== vb[i]) return false;
  }
  return true;
}
