/** Ordering and ownership only: callers supply their own authority checks. */
export type ClipboardCopy = Readonly<{ value: string; id: number }>;
type ClipboardPort = Pick<Clipboard, "readText" | "writeText">;
let sequence = 0;
let accepted: ClipboardCopy | null = null;
let acceptedId = 0;

export function beginClipboardCopy(value: string): ClipboardCopy {
  return { value, id: ++sequence };
}

export function acceptClipboardCopy(copy: ClipboardCopy): boolean {
  if (acceptedId > copy.id) return false;
  acceptedId = copy.id;
  accepted = copy;
  return true;
}

/** Read/write are not atomic; erase only with a readable ownership witness. */
export async function clearClipboardCopy(
  copy: ClipboardCopy,
  port: ClipboardPort,
): Promise<void> {
  const before = sequence;
  try {
    const value = await port.readText();
    if (
      before === sequence &&
      value === copy.value &&
      !(accepted && accepted.id > copy.id && accepted.value === value)
    )
      await port.writeText("");
  } catch {
    // Unknown ownership never authorizes clearing somebody else's clipboard.
  }
  if (accepted === copy) accepted = null;
}
