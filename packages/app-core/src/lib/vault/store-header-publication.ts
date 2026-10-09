/** Original checked publication effects only; never an owner or admission issuer. */
import type { VaultHeader } from "@opensesame/vault-core";
import { HEADER_PATH, readPlaintextFile, writePlaintextFile } from "../vfs.js";

/** A root turn carries the current BODY witness into its final HEADER. */
export function withBodyWitness(
  previous: VaultHeader | null,
  next: VaultHeader,
): VaultHeader {
  const witness = previous?.bodyRev ?? 0;
  return witness > (next.bodyRev ?? 0) ? { ...next, bodyRev: witness } : next;
}

export async function publishOriginalHeader(
  tomb: string,
  text: () => string,
  previous: string | null,
  check: () => void,
  prepare: () => Promise<void>,
  failed: (unchangedPhysical: boolean) => void,
): Promise<void> {
  try {
    check();
    await prepare();
    check();
    await writePlaintextFile(tomb, HEADER_PATH, text(), check);
    check();
  } catch (error) {
    check();
    failed(readPlaintextFile(tomb, HEADER_PATH) === previous);
    throw error;
  }
}
