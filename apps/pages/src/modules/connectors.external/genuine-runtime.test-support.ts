/** Real owner setup for transport tests; does not bypass the Store session verdict. */
import { kvFlush, kvForgetAll } from "@opensesame/app-core/lib/kv.js";
import { vaultStore } from "@opensesame/app-core/lib/vault/store.js";
import { vfsFlush } from "@opensesame/app-core/lib/vfs.js";
export async function closeGenuineRuntimeFixture() {
  await vaultStore.flushPendingWrites();
  await vfsFlush();
  await kvFlush();
  vaultStore.lock();
  await vfsFlush();
  await kvFlush();
}
export async function genuineRuntimeFixture() {
  await closeGenuineRuntimeFixture();
  kvForgetAll();
  vaultStore.loadActiveProjectScope();
  await vaultStore.create("controlled genuine native provider runtime fixture");
}
