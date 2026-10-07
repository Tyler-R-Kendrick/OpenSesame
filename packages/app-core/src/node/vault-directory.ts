/**
 * A vault kept in a directory of real files (ADR 0182): the one call the CLI
 * makes to put the shared core's VFS on the host's disk. Every secret is a file
 * under `<root>/<tomb>/secrets/`, written atomically and owner-only; the
 * retry-and-breaker policy that guards a network store guards the disk too,
 * because a busy file or a full disk is the same kind of failure.
 */
import { Effect } from "effect";
import { installFileBackedVfs } from "../lib/secret-fs/install.js";
import { resilient } from "../lib/secret-fs/resilient.js";
import { nodeSecretFiles } from "./secret-files.js";

export type VaultDirectory = Readonly<{
  root: string;
  /** Put the VFS back as it was. Writes already made are on disk. */
  close: () => void;
}>;

export async function useVaultDirectory(root: string): Promise<VaultDirectory> {
  const files = await Effect.runPromise(
    nodeSecretFiles(root).pipe(Effect.flatMap((disk) => resilient(disk))),
  );
  return { root, close: await installFileBackedVfs(files) };
}
