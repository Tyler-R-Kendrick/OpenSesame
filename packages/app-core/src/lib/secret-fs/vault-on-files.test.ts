import { makeMemorySecretFiles } from "./memory.js";
import { describeVaultOnFiles } from "./vault-on-files.conformance.js";

describeVaultOnFiles("the emulated store", async () => ({
  files: makeMemorySecretFiles(),
}));
