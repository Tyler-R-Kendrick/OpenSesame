import { describe, expect, it } from "vitest";
import {
  MAX_SLOT_PAYLOAD_BYTES,
  createIndependentCompartmentKey,
  openProfileSlot,
  sealProfileSlot,
} from "./slots.js";

const ctx = {
  vaultRef: "v1",
  deviceBindingRef: "d1",
  policyRevision: 1,
  keyEpoch: 1,
} as const;

const seal = (plaintext: Parameters<typeof sealProfileSlot>[0]["plaintext"]) =>
  sealProfileSlot({
    code: "12345678",
    slotId: "s1",
    profileId: "p1",
    ...ctx,
    plaintext,
  });

describe("slot payload", () => {
  it("round-trips beside the presentation", async () => {
    const payload = new TextEncoder().encode('{"e":"freeze","v":1,"b":{}}');
    const slot = await seal({
      compartmentKey: createIndependentCompartmentKey(),
      actionCapability: null,
      presentation: "locked",
      payload,
    });
    const opened = await openProfileSlot("12345678", slot, ctx);
    expect(opened?.presentation).toBe("locked");
    expect([...(opened?.payload ?? [])]).toEqual([...payload]);
  });

  it("leaves a slot with no payload exactly as it was: none comes back", async () => {
    const slot = await seal({
      compartmentKey: createIndependentCompartmentKey(),
      actionCapability: new Uint8Array([1, 2]),
      presentation: "decoy",
    });
    const opened = await openProfileSlot("12345678", slot, ctx);
    expect(opened?.presentation).toBe("decoy");
    expect(opened && "payload" in opened).toBe(false);
  });

  it("treats an empty payload as none", async () => {
    const slot = await seal({
      compartmentKey: createIndependentCompartmentKey(),
      actionCapability: null,
      presentation: "decoy",
      payload: new Uint8Array(0),
    });
    const opened = await openProfileSlot("12345678", slot, ctx);
    expect(opened?.presentation).toBe("decoy");
    expect(opened && "payload" in opened).toBe(false);
  });

  it("refuses a payload past the cap, and a presentation holding a NUL", async () => {
    const key = createIndependentCompartmentKey();
    await expect(
      seal({
        compartmentKey: key,
        actionCapability: null,
        presentation: "locked",
        payload: new Uint8Array(MAX_SLOT_PAYLOAD_BYTES + 1).fill(1),
      }),
    ).rejects.toThrow(/too large/);
    await expect(
      seal({
        compartmentKey: key,
        actionCapability: null,
        presentation: "locked\u0000x",
      }),
    ).rejects.toThrow(/NUL/);
  });

  it("is sealed: the wrong code opens nothing, so no mode is readable without the code", async () => {
    const slot = await seal({
      compartmentKey: createIndependentCompartmentKey(),
      actionCapability: null,
      presentation: "locked",
      payload: new TextEncoder().encode("wipe"),
    });
    expect(await openProfileSlot("87654321", slot, ctx)).toBeNull();
    expect(slot.ciphertextB64).not.toContain("wipe");
  });
});
