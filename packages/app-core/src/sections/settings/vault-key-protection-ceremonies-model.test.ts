import { describe, expect, it } from "vitest";
import { headerHolding as header } from "../../lib/vault/protection/held-wraps.test-support.js";
import {
  rotationKeeps,
  rotationLosses,
} from "./vault-key-protection-ceremonies-model.js";

describe("which key a rotation ends on (ADR 0180)", () => {
  it("keeps a master password the vault holds, whatever the browser can do", () => {
    expect(rotationKeeps(header({ password: true }), true)).toBe("password");
    expect(
      rotationKeeps(header({ password: true, passkey: true }), false),
    ).toBe("password");
  });

  it("re-keys a vault with no password under a new passkey where the browser can make one", () => {
    expect(rotationKeeps(header({ passkey: true }), true)).toBe("passkey");
    expect(rotationKeeps(header({ pin: true }), true)).toBe("passkey");
    expect(rotationKeeps(null, true)).toBe("passkey");
  });

  it("falls back to a PIN where it cannot, and never to a password", () => {
    expect(rotationKeeps(header({ passkey: true }), false)).toBe("pin");
    expect(rotationKeeps(null, false)).toBe("pin");
  });
});

describe("what a rotation takes with it", () => {
  const all = header({ password: true, pin: true, passkey: true });

  it("names every wrap but the one it keeps", () => {
    const keepsPassword = rotationLosses(all, "password");
    const keepsPasskey = rotationLosses(all, "passkey");
    const keepsPin = rotationLosses(all, "pin");
    expect(keepsPassword).toHaveLength(2);
    expect(keepsPasskey).toHaveLength(2);
    expect(keepsPin).toHaveLength(2);
    expect(new Set([...keepsPassword, ...keepsPasskey, ...keepsPin]).size).toBe(
      3,
    );
  });

  it("does not call the replaced passkey lost when a new passkey takes its place", () => {
    const lostWithPasskey = rotationLosses(
      header({ passkey: true }),
      "passkey",
    );
    expect(lostWithPasskey).toEqual([]);
  });

  it("counts second steps and recovery codes as lost with the old key", () => {
    const withGate = header({ password: true, totp: true });
    expect(rotationLosses(withGate, "password")).toContain("Authenticator app");
  });

  it("defaults to keeping the password, as the sheet did before", () => {
    expect(rotationLosses(all)).toEqual(rotationLosses(all, "password"));
  });
});
