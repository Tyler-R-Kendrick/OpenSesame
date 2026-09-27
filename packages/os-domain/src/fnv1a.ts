/**
 * 32-bit FNV-1a over a string's UTF-16 code units, as eight hex digits.
 *
 * A deterministic change detector for ids and cache names — never a security
 * boundary: collisions are cheap to find. One implementation, pinned to the
 * published vectors (a wrong offset basis or prime still yields eight hex
 * digits; #470 found exactly that mistake in a 64-bit copy).
 */
export function fnv1a32Hex(input: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}
