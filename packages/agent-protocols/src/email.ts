const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function normalizeLoginHint(hint: string): string {
  return hint.trim().toLowerCase();
}

export function isEmailLoginHint(hint: string): boolean {
  const normalized = normalizeLoginHint(hint);
  return normalized.length <= 320 && EMAIL_RE.test(normalized);
}
