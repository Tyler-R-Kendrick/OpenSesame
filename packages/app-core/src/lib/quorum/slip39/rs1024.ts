/**
 * The RS1024 checksum: a Reed-Solomon code over GF(1024) that detects any
 * error touching at most three words (SLIP-0039, "Checksum"). The
 * customization string is fed in first, one US-ASCII value per character.
 */

const GENERATOR: readonly number[] = [
  0xe0e040, 0x1c1c080, 0x3838100, 0x7070200, 0xe0e0009, 0x1c0c2412, 0x38086c24,
  0x3090fc48, 0x21b1f890, 0x3f3f120,
];

export const CUSTOMIZATION_ORIGINAL = "shamir";
export const CUSTOMIZATION_EXTENDABLE = "shamir_extendable";

export const CHECKSUM_WORDS = 3;

function polymod(values: readonly number[]): number {
  let chk = 1;
  for (const v of values) {
    const top = chk >>> 20;
    chk = ((chk & 0xfffff) << 10) ^ v;
    for (let i = 0; i < 10; i += 1) {
      if ((top >> i) & 1) chk ^= GENERATOR[i] ?? 0;
    }
  }
  return chk;
}

function asciiValues(customization: string): number[] {
  return [...customization].map((c) => c.charCodeAt(0));
}

export function customizationFor(extendable: boolean): string {
  return extendable ? CUSTOMIZATION_EXTENDABLE : CUSTOMIZATION_ORIGINAL;
}

export function verifyChecksum(
  customization: string,
  words: readonly number[],
): boolean {
  return polymod([...asciiValues(customization), ...words]) === 1;
}

export function createChecksum(
  customization: string,
  words: readonly number[],
): number[] {
  const values = [...asciiValues(customization), ...words, 0, 0, 0];
  const poly = polymod(values) ^ 1;
  return [0, 1, 2].map((i) => (poly >> (10 * (2 - i))) & 1023);
}
