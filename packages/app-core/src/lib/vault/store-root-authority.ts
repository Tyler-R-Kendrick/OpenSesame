/** Independently authenticated stores can hold distinct CryptoKeys for the same root. */
import { assertTombRealmAuthority } from "../vfs-authority.js";
import { assertRootGeneration } from "../vfs-root-admission.js";
import {
  HEADER_PATH,
  authenticateTombRootGeneration,
  pinTombAuthority,
  readPlaintextFile,
} from "../vfs.js";
export function pinStoredRootAuthority(
  tomb: string,
  key: CryptoKey,
): () => void {
  const assertStorage = pinTombAuthority(tomb);
  const assertCurrent = () => {
    assertStorage();
    assertTombRealmAuthority(tomb, key);
    assertRootGeneration(tomb, key, readPlaintextFile(tomb, HEADER_PATH));
  };
  assertCurrent();
  return assertCurrent;
}

/** A peer's legacy projection is accepted only after proving it uses this actual root. */
export async function refreshStoredRootProof(
  tomb: string,
  key: CryptoKey,
  readRaw: () => Uint8Array,
  check: () => void,
): Promise<void> {
  check();
  const header = readPlaintextFile(tomb, HEADER_PATH);
  try {
    pinTombAuthority(tomb)();
    assertRootGeneration(tomb, key, header);
    return;
  } catch {
    assertTombRealmAuthority(tomb, key);
  }
  const raw = readRaw().slice();
  try {
    await authenticateTombRootGeneration(tomb, key, raw, check);
  } finally {
    raw.fill(0);
  }
}
