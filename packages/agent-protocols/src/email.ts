const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function normalizeLoginHint(hint: string): string {
  return hint.trim().toLowerCase();
}

export function isEmailLoginHint(hint: string): boolean {
  return EMAIL_RE.test(normalizeLoginHint(hint));
}
