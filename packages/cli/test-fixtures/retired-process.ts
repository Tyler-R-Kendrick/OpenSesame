/** Public fixture passwords exercise cold-process persistence, never real secrets. */
import { runCli } from "../src/run.js";
import { releaseVaultKv } from "../src/vault-kv.js";
const stateDir = process.argv[2];
if (!stateDir) throw new Error("Fixture state directory required.");
const synthetic = process.argv[3] === "synthetic";
const password = synthetic
  ? "retired owner password 7391"
  : "correct horse battery staple";
process.exitCode = await runCli(["vault", "list", "--json"], {
  stateDir,
  readPassword: async () => password,
});
await releaseVaultKv();
