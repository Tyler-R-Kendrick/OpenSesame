/** Enrolled peer root trust metadata (PWA ARK; Rust `RootTrustRecord` parity). */

export type PeerTrustRecord = Readonly<{
  spkiFingerprint: string;
  enrollmentEpoch: number;
}>;

export type PeerTrustRecordError = "invalid";

const FINGERPRINT_RE = /^[0-9a-f]{64}$/;

export function parsePeerTrustRecord(input: {
  spkiFingerprint: string;
  enrollmentEpoch: number;
}): PeerTrustRecord | PeerTrustRecordError {
  if (
    input.enrollmentEpoch < 1 ||
    !FINGERPRINT_RE.test(input.spkiFingerprint)
  ) {
    return "invalid";
  }
  return {
    spkiFingerprint: input.spkiFingerprint,
    enrollmentEpoch: input.enrollmentEpoch,
  };
}

export function nextEnrollmentEpoch(current: PeerTrustRecord | null): number {
  if (!current) return 1;
  return current.enrollmentEpoch + 1;
}
