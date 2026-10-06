/**
 * The bech32 checksum (BIP-173), enough to say whether an age recipient or
 * identity is well formed without loading `age-encryption`. SOPS parses its
 * recipients while reading a configuration, synchronously and before any
 * cryptography runs; the library loads later, when an envelope is wrapped or
 * opened. An age string is bech32 (not bech32m) with a 52-group payload.
 */

const CHARSET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";
const GENERATOR = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];

function polymod(values: readonly number[]): number {
  let check = 1;
  for (const value of values) {
    const top = check >>> 25;
    check = ((check & 0x1ffffff) << 5) ^ value;
    for (let bit = 0; bit < 5; bit++) {
      if ((top >>> bit) & 1) check ^= GENERATOR[bit] ?? 0;
    }
  }
  return check >>> 0;
}

function expandHrp(hrp: string): number[] {
  const high = [...hrp].map((char) => char.charCodeAt(0) >>> 5);
  const low = [...hrp].map((char) => char.charCodeAt(0) & 31);
  return [...high, 0, ...low];
}

/**
 * True when `text` is `hrp` + "1" + `groups` five-bit symbols + a valid
 * six-symbol checksum, in one letter case throughout.
 */
export function isBech32(text: string, hrp: string, groups: number): boolean {
  if (text !== text.toLowerCase() && text !== text.toUpperCase()) return false;
  const lower = text.toLowerCase();
  const prefix = `${hrp.toLowerCase()}1`;
  if (!lower.startsWith(prefix)) return false;
  const data = lower.slice(prefix.length);
  if (data.length !== groups + 6) return false;
  const values: number[] = [];
  for (const char of data) {
    const at = CHARSET.indexOf(char);
    if (at < 0) return false;
    values.push(at);
  }
  return polymod([...expandHrp(hrp.toLowerCase()), ...values]) === 1;
}
