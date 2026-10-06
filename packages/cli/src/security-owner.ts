import type { OwnerProof } from "@opensesame/app-core/lib/credential-canaries/index.js";
import { assertNotDecoySession } from "@opensesame/app-core/lib/decoy-session.js";
import { retiredCredentialEnrollmentSupported } from "@opensesame/app-core/lib/retired-credentials/index.js";
import { defaultStateDir } from "@opensesame/app-core/node/host.js";
import { bootHeadlessComposition } from "./headless-composition.js";
import { readPasswordFromTty } from "./tty-password.js";
import type { VaultItemDependencies } from "./vault-items.js";
import { releaseVaultKv } from "./vault-kv.js";
import { openLocalVault, unlockLocalVault } from "./vault-session.js";
/** CLI factor support remains explicit; an unlocked session never replaces fresh proof. */
export async function withSecurityOwner(
  mutating: boolean,
  deps: VaultItemDependencies,
  work: (proof: OwnerProof) => Promise<number>,
): Promise<number> {
  const store = await openLocalVault(deps.stateDir);
  try {
    const currentPassword = await (deps.readPassword ?? readPasswordFromTty)(
      "Current vault password: ",
    );
    await unlockLocalVault(store, currentPassword);
    assertNotDecoySession();
    const state = store.getSnapshot();
    if (state.guest || state.decoy || state.awaitingSecondStep)
      throw new Error("Complete real owner authentication first.");
    const tomb = store.activeTomb();
    if (mutating && !retiredCredentialEnrollmentSupported(tomb))
      throw new Error(
        "This client requires one verified password protector and no additional factors for fresh owner management.",
      );
    await bootHeadlessComposition(deps.stateDir ?? defaultStateDir(), tomb);
    return await work({ tomb, currentPassword });
  } finally {
    await releaseVaultKv();
  }
}
