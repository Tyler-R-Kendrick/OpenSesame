/** Physical journal collision checks exercise real independent duress-slot crypto. */
import { expect, it } from "vitest";
import { sealProfileSlot } from "../duress/crypto/slots.js";
import {
  armPersistedUnlockEnrollment,
  sealUnlockTriggerFromCeremony,
} from "../duress/settings/unlock-arming.js";
import {
  ENROLLMENT_STATE_KEY,
  stagingKeyOf,
} from "../duress/store/boot-keys.js";
import { createEmptyEnrollmentState } from "../duress/trigger/enrollment-state.js";
import {
  OWNER_PASSWORD,
  retiredOwnerFixture,
} from "./retired-owner.fixture.js";
const primary = { kind: "password" as const, secret: OWNER_PASSWORD };
const command = (password: string) => ({
  kind: "change" as const,
  change: { type: "enroll" as const, password, response: "reject" as const },
});
it("excludes a genuine retained duress code despite absent cached enrollment", async () => {
  const f = await retiredOwnerFixture();
  const code = "739104628351";
  try {
    const state = createEmptyEnrollmentState({
      vaultRef: "duress-vault",
      deviceBindingRef: "duress-device",
      policyRevision: 1,
      keyEpoch: 1,
    });
    const slot = await sealProfileSlot({
      code,
      slotId: "slot-1",
      profileId: "profile-1",
      vaultRef: state.vaultRef,
      deviceBindingRef: state.deviceBindingRef,
      policyRevision: state.policyRevision,
      keyEpoch: state.keyEpoch,
      plaintext: {
        compartmentKey: crypto.getRandomValues(new Uint8Array(32)),
        actionCapability: null,
        presentation: "decoy",
      },
    });
    state.triggers.push({ slot, triggerKind: "application_code" });
    state.armed = true;
    f.records.set(
      ENROLLMENT_STATE_KEY,
      JSON.stringify({
        schemaVersion: 1,
        revision: 1,
        updatedAt: new Date().toISOString(),
        payload: state,
      }),
    );
    await expect(f.store.beginRetired(primary, command(code))).rejects.toThrow(
      /duress/iu,
    );
    expect(f.records.has("tomb/personal/retired-credentials.v2")).toBe(false);
    const other = await f.store.beginRetired(
      primary,
      command("unrelated former credential"),
    );
    if (other.kind !== "complete") throw new Error("Unexpected factor");
    expect(other.result.traps).toHaveLength(1);
  } finally {
    f.dispose();
  }
});
it("refuses an unfinished or malformed physical duress journal", async () => {
  const f = await retiredOwnerFixture();
  try {
    f.records.set(stagingKeyOf(ENROLLMENT_STATE_KEY), "{}");
    await expect(
      f.store.beginRetired(primary, command("former credential 123")),
    ).rejects.toThrow(/changing/iu);
    f.records.delete(stagingKeyOf(ENROLLMENT_STATE_KEY));
    f.records.set(ENROLLMENT_STATE_KEY, "{}");
    await expect(
      f.store.beginRetired(primary, command("former credential 123")),
    ).rejects.toThrow();
    expect(f.records.has("tomb/personal/retired-credentials.v2")).toBe(false);
    expect(f.held).toEqual([]);
  } finally {
    f.dispose();
  }
});

it("refuses arming a duress code enrolled after a retained retired credential", async () => {
  const f = await retiredOwnerFixture();
  const code = "739104628351";
  try {
    const enrolled = await f.store.beginRetired(primary, command(code));
    if (enrolled.kind !== "complete") throw new Error("Unexpected factor");
    const state = await sealUnlockTriggerFromCeremony({
      code,
      profileId: "later-duress",
      vaultRef: "owner-vault",
      deviceBindingRef: "owner-device",
      presentation: "decoy",
      ownerConsent: true,
      capabilities: { durableLocalStorage: true, offlineReady: true },
    });
    await expect(
      armPersistedUnlockEnrollment(state, { code, requireDurable: false }),
    ).rejects.toThrow(/retained/iu);
    expect(f.held).toEqual([]);
    expect(f.records.has(ENROLLMENT_STATE_KEY)).toBe(false);
  } finally {
    f.dispose();
  }
});
