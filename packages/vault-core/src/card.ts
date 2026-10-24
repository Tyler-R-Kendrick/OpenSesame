/**
 * Payment-card helpers shared by the vault editor and item detail.
 *
 * A number is never trusted because it starts with a scheme prefix: the
 * checksum must pass, and the length must be one the scheme issues. Only then
 * is a brand inferred. An unrecognised number keeps whatever brand a person
 * typed by hand.
 */

export type CardBrand = Readonly<{
  id: string;
  name: string;
  lengths: readonly number[];
  /** Indexes where a space belongs, before the digit at that index. */
  gaps: readonly number[];
  /** Digits in the security code. */
  securityCodeLength: number;
  matches: (digits: string) => boolean;
}>;

export const CARD_BRANDS: readonly CardBrand[] = [
  {
    id: "visa",
    name: "Visa",
    lengths: [13, 16, 19],
    gaps: [4, 8, 12, 16],
    securityCodeLength: 3,
    matches: (digits) => /^4/.test(digits),
  },
  {
    id: "mastercard",
    name: "Mastercard",
    lengths: [16],
    gaps: [4, 8, 12],
    securityCodeLength: 3,
    // 51–55, and 2221–2720.
    matches: (digits) =>
      /^5[1-5]/.test(digits) ||
      /^2(?:2(?:2[1-9]|[3-9]\d)|[3-6]\d{2}|7(?:[01]\d|20))/.test(digits),
  },
  {
    id: "amex",
    name: "American Express",
    lengths: [15],
    gaps: [4, 10],
    securityCodeLength: 4,
    matches: (digits) => /^3[47]/.test(digits),
  },
  {
    id: "discover",
    name: "Discover",
    lengths: [16, 17, 18, 19],
    gaps: [4, 8, 12, 16],
    securityCodeLength: 3,
    matches: (digits) =>
      /^(?:6011|65|64[4-9]|622(?:12[6-9]|1[3-9]\d|[2-8]\d{2}|9[01]\d|92[0-5]))/.test(
        digits,
      ),
  },
  {
    id: "diners",
    name: "Diners Club",
    lengths: [14, 16, 19],
    gaps: [4, 8, 12, 16],
    securityCodeLength: 3,
    matches: (digits) => /^3(?:0[0-5]|[68])/.test(digits),
  },
  {
    id: "jcb",
    name: "JCB",
    lengths: [16, 17, 18, 19],
    gaps: [4, 8, 12, 16],
    securityCodeLength: 3,
    matches: (digits) => /^35(?:2[89]|[3-8]\d)/.test(digits),
  },
  {
    id: "unionpay",
    name: "UnionPay",
    lengths: [16, 17, 18, 19],
    gaps: [4, 8, 12, 16],
    securityCodeLength: 3,
    matches: (digits) => /^62/.test(digits),
  },
  {
    id: "maestro",
    name: "Maestro",
    lengths: [12, 13, 14, 15, 16, 17, 18, 19],
    gaps: [4, 8, 12, 16],
    securityCodeLength: 3,
    matches: (digits) =>
      /^(?:5018|5020|5038|56|57|58|6304|6759|676[1-3])/.test(digits),
  },
];

/** Digits only, capped at the longest number a scheme issues. */
export function cardDigits(value: string): string {
  return value.replace(/\D/g, "").slice(0, 19);
}

/** Luhn checksum over every digit in the number. */
export function cardChecksumValid(value: string): boolean {
  const digits = cardDigits(value);
  if (digits.length < 2) return false;
  let sum = 0;
  let double = false;
  for (let index = digits.length - 1; index >= 0; index -= 1) {
    let digit = Number(digits[index]);
    if (double) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
    double = !double;
  }
  return sum % 10 === 0;
}

/**
 * The brand a complete, checksum-valid number belongs to, or null when a
 * person must name it. A prefix alone is not enough.
 */
export function detectCardBrand(value: string): CardBrand | null {
  const digits = cardDigits(value);
  if (!cardChecksumValid(digits)) return null;
  return (
    CARD_BRANDS.find(
      (brand) => brand.lengths.includes(digits.length) && brand.matches(digits),
    ) ?? null
  );
}

/** A saved brand name or id, for choosing the number's grouping. */
export function cardBrandByName(value: string): CardBrand | null {
  const named = value.trim().toLowerCase();
  if (!named) return null;
  return (
    CARD_BRANDS.find(
      (brand) => brand.id === named || brand.name.toLowerCase() === named,
    ) ?? null
  );
}

/**
 * Group a number for reading and typing. The stored value stays digits; this
 * is only the presentation. A known brand chooses its own gaps (Amex 4-6-5),
 * otherwise groups of four.
 */
export function formatCardNumber(
  value: string,
  brand?: CardBrand | string | null,
): string {
  const digits = cardDigits(value);
  const known =
    brand === undefined || brand === null
      ? null
      : brand instanceof Object
        ? brand
        : cardBrandByName(brand);
  const gaps = known?.gaps ?? [4, 8, 12, 16];
  let formatted = "";
  for (let index = 0; index < digits.length; index += 1) {
    if (index > 0 && gaps.includes(index)) formatted += " ";
    formatted += digits[index];
  }
  return formatted;
}
