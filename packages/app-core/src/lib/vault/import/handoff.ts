/**
 * One-shot handoff of a file picked in the vault to the import panel in
 * Settings. A `File` cannot travel through a router link, so the button that
 * opened the OS picker leaves it here and navigates; the panel takes it on
 * mount and starts reading without asking for the file a second time.
 */
let pending: File | null = null;

export function stashImportFile(file: File): void {
  pending = file;
}

/** Returns the stashed file exactly once; later calls return null. */
export function takeImportFile(): File | null {
  const file = pending;
  pending = null;
  return file;
}
