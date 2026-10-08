/** Actual independent process for the device-metadata serialization regression. */
import { configureHost } from "../src/host.js";
import { createDeviceConnection } from "../src/lib/device-connectors.js";
import { kvFlush, kvHydrate } from "../src/lib/kv.js";
import { vaultStore } from "../src/lib/vault/store.js";
import { tombStorageKeys } from "../src/lib/vault/tomb-migration.js";
import { createNodeHost } from "../src/node/host.js";
const [stateDir, password, name] = process.argv.slice(2);
if (!stateDir || !password || !name)
  throw new Error("Missing metadata fixture parameters.");
configureHost(createNodeHost({ stateDir }));
await kvHydrate([
  ...tombStorageKeys("personal"),
  "opensesame.device-connectors.v1",
]);
vaultStore.rehydrate();
await vaultStore.unlock(password);
process.stdout.write("ready\n");
await new Promise<void>((resolve) =>
  process.stdin.once("data", () => resolve()),
);
const created = await createDeviceConnection({
  providerId: "anthropic",
  displayName: name,
});
await kvFlush();
vaultStore.lock();
process.stdout.write(`${created.connectionId}\n`);

process.stdin.destroy();
