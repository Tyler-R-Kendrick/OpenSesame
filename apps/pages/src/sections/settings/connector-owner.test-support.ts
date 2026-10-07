import { persistentBrowserOwner } from "@opensesame/app-core/browser/security-integration/management-host.fixture.js";
import { configureHost } from "@opensesame/app-core/host.js";
import { kvFlush, kvForgetAll } from "@opensesame/app-core/lib/kv.js";
import { vaultStore } from "@opensesame/app-core/lib/vault/store.js";
import { createTestHost } from "@opensesame/app-core/test-host.js";
/** Real root admission and browser storage; only physical browser APIs are doubled. */
export async function admitConnectorOwner() {
  const owner = await persistentBrowserOwner();
  await vaultStore.unlock(owner.password);
}
export async function releaseConnectorOwner() {
  vaultStore.lock();
  await kvFlush();
  kvForgetAll();
  configureHost(createTestHost());
}
