/** Captured transport identity and cancellation only; supplies no authority. */
import { vfsSeams } from "./vfs-seams.js";
export function originalVfsCheck(check?: () => void): () => void {
  const { readRaw, writeRaw, open, seal } = vfsSeams;
  const active = () => {
    check?.();
    if (
      vfsSeams.readRaw !== readRaw ||
      vfsSeams.writeRaw !== writeRaw ||
      vfsSeams.open !== open ||
      vfsSeams.seal !== seal
    )
      throw new Error("Original vault transport changed.");
  };
  active();
  return active;
}
