/** @vitest-environment jsdom */
/**
 * `cached-offline`: a lifecycle the store projects from what the worker
 * reports saved, never a resolve — the plan, its digest and the lease stay
 * exactly as they were (carried from #470's cached status).
 */
import { beforeEach, describe, expect, it } from "vitest";
import {
  bootPersonalLocal,
  draftFor,
  freshRealm,
} from "./__tests__/harness.js";
import { compositionStore } from "./store.js";

const PASSKEYS = "vault.passkey-records";

beforeEach(freshRealm);

async function withPasskeys(): Promise<void> {
  await bootPersonalLocal(compositionStore);
  const { draft, receipt } = draftFor(compositionStore, [PASSKEYS], "r1");
  const outcome = await compositionStore.commit(draft, receipt);
  if (outcome.status !== "committed") throw new Error(outcome.status);
}

function lifecycle(id: string) {
  return compositionStore.getSnapshot().lifecycle[id];
}

describe("cached-offline", () => {
  it("an approved capability whose page modules are saved reads cached-offline, without a resolve", async () => {
    await withPasskeys();
    const before = compositionStore.getSnapshot();
    const lease = compositionStore.currentLease();
    expect(lifecycle(PASSKEYS)).toBe("approved-not-loaded");

    compositionStore.setOfflineSaved([`${PASSKEYS}/runtime`]);

    const after = compositionStore.getSnapshot();
    expect(lifecycle(PASSKEYS)).toBe("cached-offline");
    expect(after.generation).toBe(before.generation);
    expect(after.plan?.identity.planDigest).toBe(
      before.plan?.identity.planDigest,
    );
    expect(compositionStore.currentLease()).toBe(lease);
  });

  it("running here outranks saved; an unsaved or unapproved capability never claims it", async () => {
    await withPasskeys();
    compositionStore.setOfflineSaved([
      `${PASSKEYS}/runtime`,
      "identity.federation/runtime",
    ]);
    // Saved but never approved: its code on disk is not a claim about it.
    expect(lifecycle("identity.federation")).not.toBe("cached-offline");
    compositionStore.setActivity(PASSKEYS, "active");
    expect(lifecycle(PASSKEYS)).toBe("active");
    compositionStore.setActivity(PASSKEYS, null);
    compositionStore.setOfflineSaved([]);
    expect(lifecycle(PASSKEYS)).toBe("approved-not-loaded");
  });
});
