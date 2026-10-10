import type { PasskeyCreateOptions } from "@opensesame/app-core/lib/vault/protection/adapters/webauthn-prf-ceremony.js";
import { overlapCast } from "@opensesame/os-domain";
import type { MutableRefObject } from "react";
import { describe, expect, it, vi } from "vitest";
import { submitFirstRunUnlock } from "./unlock-form-paths.js";

/** The two ways a new vault is sealed, and nothing else (ADR 0180). */
function setup() {
  const store = {
    createWithPasskey: vi.fn(
      async (_signal?: AbortSignal, _options?: PasskeyCreateOptions) => {},
    ),
    createWithPin: vi.fn(async (_pin: string) => {}),
  };
  const passkeyAbort: MutableRefObject<AbortController | null> = {
    current: null,
  };
  const setPin = vi.fn();
  return { store, passkeyAbort, setPin };
}

describe("sealing a new vault from the first-run form", () => {
  it("seals with a passkey and lets go of the abort handle afterwards", async () => {
    const { store, passkeyAbort, setPin } = setup();
    let during: AbortController | null = null;
    store.createWithPasskey.mockImplementation(async () => {
      during = passkeyAbort.current;
    });
    await submitFirstRunUnlock({
      activeMethod: "passkey",
      store: overlap(store),
      passkeyAbort,
      pin: "",
      confirm: "",
      setPin,
    });
    expect(store.createWithPasskey).toHaveBeenCalledTimes(1);
    expect(during).toBeInstanceOf(AbortController);
    expect(passkeyAbort.current).toBeNull();
    expect(store.createWithPin).not.toHaveBeenCalled();
  });

  it("names the kind of authenticator the person chose", async () => {
    const { store, passkeyAbort, setPin } = setup();
    await submitFirstRunUnlock({
      activeMethod: "passkey",
      store: overlap(store),
      passkeyAbort,
      attachment: "cross-platform",
      pin: "",
      confirm: "",
      setPin,
    });
    expect(store.createWithPasskey).toHaveBeenCalledWith(
      expect.any(AbortSignal),
      { attachment: "cross-platform" },
    );
  });

  it("seals with a PIN once both entries match, and forgets the PIN", async () => {
    const { store, passkeyAbort, setPin } = setup();
    await submitFirstRunUnlock({
      activeMethod: "pin",
      store: overlap(store),
      passkeyAbort,
      pin: "48291037",
      confirm: "48291037",
      setPin,
    });
    expect(store.createWithPin).toHaveBeenCalledWith("48291037");
    expect(setPin).toHaveBeenCalledWith("");
  });

  it("refuses a PIN whose two entries differ, and seals nothing", async () => {
    const { store, passkeyAbort, setPin } = setup();
    await expect(
      submitFirstRunUnlock({
        activeMethod: "pin",
        store: overlap(store),
        passkeyAbort,
        pin: "48291037",
        confirm: "48291038",
        setPin,
      }),
    ).rejects.toThrow("The two entries do not match.");
    expect(store.createWithPin).not.toHaveBeenCalled();
    expect(setPin).not.toHaveBeenCalled();
  });

  it.each(["password", "recovery", "age", "agePasskey"] as const)(
    "refuses to seal a new vault with %s",
    async (activeMethod) => {
      const { store, passkeyAbort, setPin } = setup();
      await expect(
        submitFirstRunUnlock({
          activeMethod,
          store: overlap(store),
          passkeyAbort,
          pin: "48291037",
          confirm: "48291037",
          setPin,
        }),
      ).rejects.toThrow("Seal this device with a passkey or a PIN.");
      expect(store.createWithPasskey).not.toHaveBeenCalled();
      expect(store.createWithPin).not.toHaveBeenCalled();
    },
  );
});

/** The form hands over the whole store; these two verbs are all this path reads. */
function overlap(
  store: ReturnType<typeof setup>["store"],
): Parameters<typeof submitFirstRunUnlock>[0]["store"] {
  return overlapCast(store);
}
