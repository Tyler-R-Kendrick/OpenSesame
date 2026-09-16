export const MAX_ID_TOKEN_CHARS = 16_384;
export const MAX_AUTH_REQUEST_CHARS = 8_192;
export const MAX_FRAGMENT_RESPONSE_CHARS = 16_384;
export const DEFAULT_ID_TOKEN_TTL_SECONDS = 600;
export const MAX_ID_TOKEN_TTL_SECONDS = 3_600;
export const DEFAULT_CLOCK_SKEW_SECONDS = 60;
export const MAX_CLOCK_SKEW_SECONDS = 300;
export const DEFAULT_MAX_IAT_AGE_SECONDS = 600;
export const MAX_MAX_IAT_AGE_SECONDS = 3_600;
export const MIN_EPOCH_SECONDS = 0;
export const MAX_EPOCH_SECONDS = 253_402_300_799;

export function clampNonNegativeInt(
  value: number | undefined,
  fallback: number,
  ceiling: number,
): number {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < 0 || value > ceiling) {
    return -1;
  }
  return value;
}
