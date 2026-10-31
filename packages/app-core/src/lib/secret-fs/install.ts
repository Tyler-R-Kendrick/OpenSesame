/**
 * Make the VFS keep the vault in a secret file store (ADR 0182). A host calls
 * this once at start, before anything opens a vault: the CLI with a directory
 * on disk, a PWA served for a privately hosted store with the HTTP store
 * behind `resilient`, a test with the emulation. It returns the way back.
 */
import { vfsSeams } from "../vfs-seams.js";
import type { SecretFiles } from "./files.js";
import { createFileBackedVfs } from "./vfs-files.js";

export async function installFileBackedVfs(
  files: SecretFiles,
): Promise<() => void> {
  const previous = { ...vfsSeams };
  const adapter = createFileBackedVfs(files, previous);
  await adapter.hydrate();
  Object.assign(vfsSeams, adapter.seams);
  // This legacy adapter has no fresh physical refresh yet; never borrow the device KV transport.
  Reflect.deleteProperty(vfsSeams, "refreshRaw");
  Reflect.deleteProperty(vfsSeams, "writeRawGuarded");
  if (!adapter.seams.writeOwnedMetadata)
    Reflect.deleteProperty(vfsSeams, "writeOwnedMetadata");
  return () => {
    vfsSeams.readRaw = previous.readRaw;
    vfsSeams.writeRaw = previous.writeRaw;
    if (previous.writeRawGuarded)
      vfsSeams.writeRawGuarded = previous.writeRawGuarded;
    else Reflect.deleteProperty(vfsSeams, "writeRawGuarded");
    if (previous.writeOwnedMetadata)
      vfsSeams.writeOwnedMetadata = previous.writeOwnedMetadata;
    else Reflect.deleteProperty(vfsSeams, "writeOwnedMetadata");
    vfsSeams.deleteRaw = previous.deleteRaw;
    if (previous.refreshRaw) vfsSeams.refreshRaw = previous.refreshRaw;
    else Reflect.deleteProperty(vfsSeams, "refreshRaw");
    if (previous.openBody) vfsSeams.openBody = previous.openBody;
    else Reflect.deleteProperty(vfsSeams, "openBody");
  };
}
