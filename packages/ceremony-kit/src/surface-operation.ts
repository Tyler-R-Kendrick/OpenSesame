/** A surface may retire its own operation; portable protocol callers need no policy. */
export function beginSurfaceOperation(
  begin?: () => () => void,
): (() => void) | null {
  if (!begin) return () => {};
  try {
    return begin();
  } catch {
    return null;
  }
}
export function surfaceOperationCurrent(check: () => void): boolean {
  try {
    check();
    return true;
  } catch {
    return false;
  }
}
