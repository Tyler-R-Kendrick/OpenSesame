import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Duration, Effect, Redacted } from "effect";
import { fetchTo } from "../lib/secret-fs/fetch.test-support.js";
import { makeFilesHandler } from "../lib/secret-fs/http-handler.js";
import { makeHttpSecretFiles } from "../lib/secret-fs/http.js";
import { resilient } from "../lib/secret-fs/resilient.js";
import { describeVaultOnFiles } from "../lib/secret-fs/vault-on-files.conformance.js";
import { nodeSecretFiles } from "./secret-files.js";

describeVaultOnFiles("a directory on disk", async () => {
  const root = mkdtempSync(join(tmpdir(), "vault-on-files-"));
  return {
    files: await Effect.runPromise(nodeSecretFiles(root)),
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
});

// The shape a locally hosted PWA runs in: the vault in the browser, the files
// on a private store reached over HTTP, with the retry and breaker policy on.
describeVaultOnFiles("a private store over HTTP", async () => {
  const root = mkdtempSync(join(tmpdir(), "vault-on-http-"));
  const disk = await Effect.runPromise(nodeSecretFiles(root));
  const token = Redacted.make("a-long-enough-bearer-token");
  const handler = makeFilesHandler(disk, { token });
  const client = makeHttpSecretFiles({
    baseUrl: "https://vault.test",
    token,
    fetch: fetchTo(handler),
  });
  return {
    files: await Effect.runPromise(
      resilient(client, { backoff: Duration.millis(1) }),
    ),
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
});
