/** Values that must never appear in logs, traces, or audit metadata. */
export const sentinelValues = [
  "osc_clm_TESTSECRET",
  "device_code_TESTSECRET",
  "refresh_token_TESTSECRET",
  "authorization_code_TESTSECRET",
] as const;

export function assertNoSentinels(haystack: string): void {
  for (const s of sentinelValues) {
    if (haystack.includes(s)) {
      throw new Error(`sensitive sentinel leaked: ${s}`);
    }
  }
}
