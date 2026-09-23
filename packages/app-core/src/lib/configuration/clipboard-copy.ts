/**
 * Clipboard clear is best-effort (ADV-29). The platform may deny write or
 * navigate away before a timer fires.
 */
export async function copyTextBestEffort(
  text: string,
  clipboard: { writeText?: (value: string) => Promise<void> } | undefined,
): Promise<{ ok: true } | { ok: false; message: string }> {
  if (!clipboard?.writeText) {
    return {
      ok: false,
      message: "Clipboard is not available in this browser.",
    };
  }
  try {
    await clipboard.writeText(text);
    return { ok: true };
  } catch {
    return { ok: false, message: "Clipboard write was denied." };
  }
}
