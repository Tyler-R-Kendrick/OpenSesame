import { createItem } from "@opensesame/vault-core";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  isDecoySession,
  observeDecoyInteraction,
} from "../../lib/decoy-session.js";
import {
  clearActivePresentation,
  readActivePresentation,
} from "../../lib/duress/compartment/presentation-runtime.js";
import { hostFetch, identitySeams } from "../../lib/identity.js";
import { kvGet, kvSet } from "../../lib/kv.js";
import { retiredCredentialStatus } from "../../lib/retired-credentials/index.js";
import {
  PASSWORD,
  TRAPS_KEY,
  createRetiredCredentialFixture,
} from "../../lib/retired-credentials/test-support.js";
import { unlockWithPasswordAfterDuressGate } from "./unlock-password-duress.js";
let fixture: Awaited<ReturnType<typeof createRetiredCredentialFixture>>;
beforeEach(async () => {
  fixture = await createRetiredCredentialFixture();
  clearActivePresentation();
});
afterEach(() => {
  vi.restoreAllMocks();
  clearActivePresentation();
  fixture.restore();
});
it("records/rejects a trap before production unwrap without creating a guest session", async () => {
  await fixture.enroll("old");
  fixture.store.lock();
  const unlock = vi.spyOn(fixture.store, "unlock");
  const guest = vi.spyOn(fixture.store, "createGuest");
  await expect(
    unlockWithPasswordAfterDuressGate(fixture.store, "old"),
  ).rejects.toThrow();
  expect(unlock).not.toHaveBeenCalled();
  expect(guest).not.toHaveBeenCalled();
  expect(fixture.store.getSnapshot().status).toBe("locked");
});
it("enters a fresh independently keyed synthetic realm without production unwrap", async () => {
  await fixture.enroll("old", "synthetic_decoy");
  fixture.store.lock();
  const unlock = vi.spyOn(fixture.store, "unlock");
  expect(await unlockWithPasswordAfterDuressGate(fixture.store, "old")).toBe(
    "retired_credential_session",
  );
  expect(unlock).not.toHaveBeenCalled();
  expect(fixture.store.getSnapshot().decoy).toBe(true);
  const presentation = readActivePresentation();
  expect(presentation?.profileId).toMatch(/^retired:/);
  expect(presentation?.view.connectors).toEqual([]);
  expect(presentation?.view.items[0]?.secret).toMatch(/^synthetic-/);
});
it("fails closed on corrupt detector records before production unwrap", async () => {
  await fixture.enroll("old");
  fixture.store.lock();
  kvSet(TRAPS_KEY, '{"v":1,"tomb":"personal","traps":[{}],"events":[]}');
  const unlock = vi.spyOn(fixture.store, "unlock");
  await expect(
    unlockWithPasswordAfterDuressGate(fixture.store, "old"),
  ).rejects.toThrow();
  expect(unlock).not.toHaveBeenCalled();
});
it("preserves ordinary unlock when no retired credential matches", async () => {
  fixture.store.lock();
  expect(await unlockWithPasswordAfterDuressGate(fixture.store, PASSWORD)).toBe(
    "vault_opened",
  );
  expect(fixture.store.getSnapshot().status).toBe("unlocked");
  expect(fixture.store.getSnapshot().decoy).toBe(false);
});

it("records bounded metadata for denied authority and synthetic writes, and clears observation on lock", async () => {
  await fixture.enroll("old", "synthetic_decoy");
  fixture.store.lock();
  await unlockWithPasswordAfterDuressGate(fixture.store, "old");
  const transport = vi.spyOn(identitySeams, "hostFetch");
  await expect(hostFetch("/api/v1/test")).rejects.toThrow("authenticate again");
  expect(transport).not.toHaveBeenCalled();
  await vi.waitFor(() =>
    expect(retiredCredentialStatus("personal").events).toContainEqual(
      expect.objectContaining({
        type: "synthetic_decoy_interaction",
        action: "authority_denied",
      }),
    ),
  );
  await fixture.store.saveItem(
    createItem("note", "hostile private content never becomes telemetry"),
  );
  await vi.waitFor(() =>
    expect(retiredCredentialStatus("personal").events).toContainEqual(
      expect.objectContaining({
        type: "synthetic_decoy_interaction",
        action: "vault_write",
      }),
    ),
  );
  expect(kvGet(TRAPS_KEY)).not.toContain("hostile private content");
  fixture.store.lock();
  expect(isDecoySession()).toBe(false);
  const count = retiredCredentialStatus("personal").events.length;
  observeDecoyInteraction("vault_write");
  expect(retiredCredentialStatus("personal").events).toHaveLength(count);
});

it("refuses a scope switch while the pre-unlock trap probe is awaiting storage", async () => {
  await fixture.enroll("old", "synthetic_decoy");
  fixture.store.lock();
  vi.spyOn(fixture.store, "activeTomb")
    .mockReturnValueOnce("personal")
    .mockReturnValue("another-vault");
  const guest = vi.spyOn(fixture.store, "createGuest");
  const unlock = vi.spyOn(fixture.store, "unlock");
  await expect(
    unlockWithPasswordAfterDuressGate(fixture.store, "old"),
  ).rejects.toThrow();
  expect(guest).not.toHaveBeenCalled();
  expect(unlock).not.toHaveBeenCalled();
  expect(fixture.store.getSnapshot().status).toBe("locked");
});
