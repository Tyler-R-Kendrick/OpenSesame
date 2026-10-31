/** Captured transport identity and cancellation only; supplies no authority. */
import { vfsSeams } from "./vfs-seams.js";
export function originalVfsCheck(check?: () => void): () => void {
  const { readRaw, writeRaw, writeRawGuarded, writeOwnedMetadata, open, seal } =
    vfsSeams;
  const active = () => {
    check?.();
    if (
      vfsSeams.readRaw !== readRaw ||
      vfsSeams.writeRaw !== writeRaw ||
      vfsSeams.writeRawGuarded !== writeRawGuarded ||
      vfsSeams.writeOwnedMetadata !== writeOwnedMetadata ||
      vfsSeams.open !== open ||
      vfsSeams.seal !== seal
    )
      throw new Error("Original vault transport changed.");
  };
  active();
  return active;
}
