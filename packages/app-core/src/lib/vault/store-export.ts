import type { VaultHeader } from "@opensesame/vault-core";
import { assertNotDecoySession } from "../decoy-session.js";
import { BODY_PATH, readSealedFile } from "../vfs.js";

/** Serialize persisted ciphertext only after current real-realm authorization. */
export function exportSealedVault(
  header: VaultHeader | null,
  tomb: string,
): string {
  assertNotDecoySession();
  if (!header) throw new Error("There is no vault to export.");
  const body = readSealedFile(tomb, BODY_PATH);
  if (!body) throw new Error("There is nothing stored to export yet.");
  return JSON.stringify(
    {
      format: "opensesame-vault-export",
      v: 1,
      exportedAt: new Date().toISOString(),
      tomb,
      header,
      body,
    },
    null,
    2,
  );
}
