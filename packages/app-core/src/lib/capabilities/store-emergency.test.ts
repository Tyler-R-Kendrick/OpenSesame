/** @vitest-environment jsdom */
/**
 * Emergency disable against a vault record the resolver reads as foreign,
 * and with no vault open. The store and the resolver share one foreign test
 * (vault, installation or instance), so an emergency disable never rewrites a
 * foreign record into a narrower one — and with no vault open it disables
 * exactly the one capability, not everything.
 */

import { beforeEach, describe, expect, it } from "vitest";
import {
  approved,
  bootPersonalLocal,
  draftFor,
  durable,
  freshRealm,
} from "./__tests__/harness.js";
import { vaultSelectionKey } from "./keys.js";
import { compositionStore } from "./store.js";

const PASSKEYS = "vault.passkey-records";
const DROPS = "sharing.drops";

beforeEach(freshRealm);

async function commitBoth(vaultId: string | null): Promise<void> {
  await bootPersonalLocal(compositionStore, vaultId);
  const { draft, receipt } = draftFor(
    compositionStore,
    [PASSKEYS, DROPS],
    "r1",
  );
  const outcome = await compositionStore.commit(draft, receipt);
  if (outcome.status !== "committed") throw new Error(outcome.status);
  expect(approved(compositionStore)).toEqual(
    expect.arrayContaining([PASSKEYS, DROPS]),
  );
}

describe("emergency disable", () => {
  it("keeps a record written for another instance as it is", async () => {
    await commitBoth("personal");
    durable.set(
      vaultSelectionKey("personal"),
      JSON.stringify({
        schemaVersion: 1,
        kind: "VaultCapabilitySelection",
        instanceId: "some-other-instance",
        installationId:
          compositionStore.getSnapshot().selection?.installationId,
        vaultId: "personal",
        revision: "lifted",
        disabled: [],
      }),
    );
    compositionStore.onVaultChange(null);
    compositionStore.onVaultChange("personal");
    expect(approved(compositionStore)).not.toContain(DROPS);
    await compositionStore.emergencyDisable(PASSKEYS);
    expect(approved(compositionStore)).not.toContain(DROPS);
    expect(
      JSON.parse(durable.get(vaultSelectionKey("personal")) ?? "{}").instanceId,
    ).toBe("some-other-instance");
  });

  it("with no vault open, disables that one capability and nothing else", async () => {
    await commitBoth(null);
    await compositionStore.emergencyDisable(PASSKEYS);
    expect(approved(compositionStore)).not.toContain(PASSKEYS);
    expect(approved(compositionStore)).toContain(DROPS);
  });
});
