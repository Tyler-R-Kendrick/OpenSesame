import { describe, expect, it } from "vitest";
import { fromB64 } from "./slot-bytes.js";
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

  it("carries up to 64 KiB, the cap the visible-items plan needs, and refuses a byte more", async () => {
    expect(MAX_SLOT_PAYLOAD_BYTES).toBe(65_536);
    const payload = crypto.getRandomValues(
      new Uint8Array(MAX_SLOT_PAYLOAD_BYTES),
    );
    const slot = await seal({
      compartmentKey: createIndependentCompartmentKey(),
      actionCapability: null,
      presentation: "decoy",
      payload,
    });
    const opened = await openProfileSlot("12345678", slot, ctx);
    expect(opened?.presentation).toBe("decoy");
    expect([...(opened?.payload ?? [])]).toEqual([...payload]);
    await expect(
      seal({
        compartmentKey: createIndependentCompartmentKey(),
        actionCapability: null,
        presentation: "decoy",
        payload: new Uint8Array(MAX_SLOT_PAYLOAD_BYTES + 1),
      }),
    ).rejects.toThrow(/too large/);
  });

  it("lays out a slot as it always did, whatever the cap: only a payload adds bytes", async () => {
    const sealedLength = async (
      payload: Uint8Array | undefined,
    ): Promise<number> => {
      const base = {
        compartmentKey: new Uint8Array(32),
        actionCapability: null,
        presentation: "decoy",
      } as const;
      const slot = await seal(payload ? { ...base, payload } : base);
      return fromB64(slot.ciphertextB64).length;
    };
    // 4 + 32 key + 4 + 0 capability + "decoy", plus the 16-byte GCM tag.
    const none = 4 + 32 + 4 + 0 + 5 + 16;
    expect(await sealedLength(undefined)).toBe(none);
    expect(await sealedLength(new Uint8Array(0))).toBe(none);
    // A payload adds the NUL that ends the presentation and its own bytes.
    expect(await sealedLength(new Uint8Array(10))).toBe(none + 1 + 10);
    expect(await sealedLength(new Uint8Array(1500))).toBe(none + 1 + 1500);
    // The 8 KiB plans of before still fit and read back unchanged.
    expect(await sealedLength(new Uint8Array(8192))).toBe(none + 1 + 8192);
  });
});
