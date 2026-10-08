import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { describeVaultOnFiles } from "../lib/secret-fs/vault-on-files.conformance.js";
import { nodeSecretFiles } from "./secret-files.js";

describeVaultOnFiles("a directory on disk", async () => {
  const root = mkdtempSync(join(tmpdir(), "vault-on-files-"));
  return {
    files: await Effect.runPromise(nodeSecretFiles(root)),
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
});
