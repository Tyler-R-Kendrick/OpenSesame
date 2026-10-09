/** Hash leaves are URL data; a malformed escape must not break the section. */
export function identityRecordId(hash: string): string | null {
  if (!hash) return null;
  try {
    return decodeURIComponent(hash.slice(1));
  } catch {
    return null;
  }
}
