/** Short authentication string for a root-trust fingerprint (D7-2 d). */

export function sasFromFingerprint(fingerprint: string): string | null {
  if (!/^[\da-f]{64}$/.test(fingerprint)) return null;
  return `${fingerprint.slice(0, 4)}-${fingerprint.slice(4, 8)}-${fingerprint.slice(8, 12)}-${fingerprint.slice(12, 16)}`;
}
