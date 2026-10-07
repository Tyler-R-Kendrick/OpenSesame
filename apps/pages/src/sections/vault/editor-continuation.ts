/** Publish only while the caller's original store continuation remains valid. */
export function publishEditorContinuation(
  check: () => void,
  publish: () => void,
): void {
  try {
    check();
  } catch {
    return;
  }
  publish();
}
