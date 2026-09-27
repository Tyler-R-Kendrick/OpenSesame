/** @vitest-environment jsdom */
/**
 * The store's vault scope, carried forward from #470's chain cases: a vault
 * record that names another vault denies instead of lapsing, another
 * installation's record is set aside, an emergency disable never widens a
 * foreign record, and a vault switch re-resolves against that vault's own
 * restriction (LIFE-03).
 */

import type { VaultCapabilitySelection } from "@opensesame/capability-composition";
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

beforeEach(freshRealm);

describe("a vault record written for somewhere else", () => {
  async function withRecord(overrides: Partial<VaultCapabilitySelection>) {
    await bootPersonalLocal(compositionStore, "personal");
    const { draft, receipt } = draftFor(compositionStore, [PASSKEYS], "r1");
    await compositionStore.commit(draft, receipt);
    expect(approved(compositionStore)).toContain(PASSKEYS);
    durable.set(
      vaultSelectionKey("personal"),
      JSON.stringify({
        schemaVersion: 1,
        kind: "VaultCapabilitySelection",
        instanceId: compositionStore.instanceId(),
        installationId: draft.installationId,
        vaultId: "personal",
        revision: "lifted",
        disabled: [],
        ...overrides,
      }),
    );
    // Leave the vault and come back, so the store re-reads its record.
    compositionStore.onVaultChange(null);
    compositionStore.onVaultChange("personal");
  }

  it("a record naming another vault denies rather than lapsing (#470 S23)", async () => {
    await withRecord({ vaultId: "someone-elses" });
    expect(approved(compositionStore)).toEqual([
      "settings.core",
      "vault.passwords",
    ]);
    expect(
      compositionStore
        .getSnapshot()
        .diagnostics.some((d) => d.includes("another vault")),
    ).toBe(true);
  });

  it("an emergency disable does not rewrite a foreign record into a narrower one", async () => {
    await withRecord({ vaultId: "someone-elses" });
    await compositionStore.emergencyDisable(PASSKEYS);
    expect(approved(compositionStore)).toEqual([
      "settings.core",
      "vault.passwords",
    ]);
    expect(
      JSON.parse(durable.get(vaultSelectionKey("personal")) ?? "{}").vaultId,
    ).toBe("someone-elses");
  });

  it("a record another installation wrote is still set aside", async () => {
    // Vault files travel between devices; one device's disables are its own.
    await withRecord({
      installationId: "another-device",
      disabled: [PASSKEYS],
    });
    expect(approved(compositionStore)).toContain(PASSKEYS);
  });
});

describe("LIFE-03: a vault switch re-resolves against that vault's restriction", () => {
  it("each vault's own disables apply only while it is open (#470's allow-nothing vault)", async () => {
    await bootPersonalLocal(compositionStore, "personal");
    const { draft, receipt } = draftFor(compositionStore, [PASSKEYS], "r1");
    await compositionStore.commit(draft, receipt);
    durable.set(
      vaultSelectionKey("work"),
      JSON.stringify({
        schemaVersion: 1,
        kind: "VaultCapabilitySelection",
        instanceId: compositionStore.instanceId(),
        installationId: draft.installationId,
        vaultId: "work",
        revision: "w1",
        disabled: [PASSKEYS],
      }),
    );
    const before = compositionStore.getSnapshot().generation;
    compositionStore.onVaultChange("work");
    expect(compositionStore.getSnapshot().generation).toBeGreaterThan(before);
    expect(approved(compositionStore)).not.toContain(PASSKEYS);
    compositionStore.onVaultChange("personal");
    expect(approved(compositionStore)).toContain(PASSKEYS);
  });
});
