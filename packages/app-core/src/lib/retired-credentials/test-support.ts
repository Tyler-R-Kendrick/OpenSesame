import { webLocksDouble } from "../__tests__/web-locks-double.js";
import { markDecoySession } from "../decoy-session.js";
import { clearEnrollmentStateForUnlock } from "../duress/store/unlock-enrollment.js";
import { kvDelete } from "../kv.js";
import {
  PASSWORD,
  clearVaultSurface,
} from "../vault/protection/protector-enrollment.test-support.js";
import { VaultStore } from "../vault/store.js";
import { tombFileKey } from "../vfs.js";
import {
  type RetiredCredentialResponse,
  enrollRetiredCredential,
  retiredCredentialOwnerSeams,
  retiredCredentialStorageSeams,
} from "./index.js";
import { flushRetiredCredentialTelemetry } from "./telemetry-queue.js";
export { PASSWORD };
export const TRAPS_KEY = tombFileKey("personal", "retired-credentials.v1");
export async function createRetiredCredentialFixture() {
  // Finish earlier evidence work before clearing its storage or replacing ports.
  await flushRetiredCredentialTelemetry();
  const owner = retiredCredentialOwnerSeams.isRealOwner;
  const storage = { ...retiredCredentialStorageSeams };
  await clearVaultSurface();
  clearEnrollmentStateForUnlock();
  kvDelete(TRAPS_KEY);
  markDecoySession(false);
  const store = new VaultStore();
  const locks = webLocksDouble();
  retiredCredentialOwnerSeams.isRealOwner = (tomb) =>
    store.getSnapshot().status === "unlocked" &&
    !store.getSnapshot().guest &&
    store.activeTomb() === tomb;
  retiredCredentialStorageSeams.refresh = async () => {};
  retiredCredentialStorageSeams.locks = () => locks;
  await store.create(PASSWORD);
  store.lock();
  await store.unlock(PASSWORD);
  await store.flushPendingWrites();
  return {
    store,
    locks,
    enroll: (
      retiredPassword = "retired-secret",
      response: RetiredCredentialResponse = "reject",
    ) =>
      enrollRetiredCredential({
        tomb: "personal",
        currentPassword: PASSWORD,
        retiredPassword,
        response,
        acknowledgePasswordVerifierRisk: true,
      }),
    restore: () => {
      store.lock();
      markDecoySession(false);
      retiredCredentialOwnerSeams.isRealOwner = owner;
      Object.assign(retiredCredentialStorageSeams, storage);
    },
  };
}
