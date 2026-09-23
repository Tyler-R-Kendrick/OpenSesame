import { type BoundaryValue, overlapCast } from "@opensesame/os-domain";
import {
  VaultCorruptError,
  type VaultHeader,
  WrongPasswordError,
  createVault,
  importVaultKey,
  randomBytes,
} from "@opensesame/vault-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  MAX_PIN_LENGTH,
  MIN_PIN_LENGTH,
  type PinUnlockRecord,
  WebauthnHostError,
  assertKeepsPrimaryUnlock,
  assertPinPolicy,
  assertWebauthnHost,
  checkWebauthnHost,
  createPasskeyUnlockCeremony,
  describeWebauthnError,
  exportRawVaultKey,
  formatWebauthnHostError,
  getPasskeyUnlockCeremony,
  isIpHostname,
  localhostEquivalentHref,
  openTotpSecret,
  pinPolicyProblems,
  preferredUnlockMethod,
  prfExtensionSupported,
  primaryUnlockCount,
  readPrfFirst,
  sealTotpSecret,
  unwrapVaultKeyWithPin,
  unwrapVaultKeyWithPrf,
  wrapVaultKeyWithPin,
  wrapVaultKeyWithPrf,
} from "./unlock-methods.js";

const PASSWORD = "correct horse battery staple";
const PIN = "48291037";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("pinPolicyProblems", () => {
  it("returns nothing for a solid PIN and names every violation otherwise", () => {
    expect(pinPolicyProblems(PIN)).toEqual([]);
    expect(pinPolicyProblems("13579246")).toEqual([]);
    // Short and sequential: both named, length first.
    expect(pinPolicyProblems("1234")).toEqual([
      "PIN must be 8–12 characters.",
      "PIN cannot be a sequential run of digits.",
    ]);
    expect(pinPolicyProblems("4829 1037")).toEqual([
      "PIN cannot contain spaces.",
    ]);
    expect(pinPolicyProblems("11111111")).toEqual([
      "PIN cannot be a repeated character.",
    ]);
    expect(pinPolicyProblems("12345678")).toEqual([
      "PIN cannot be a sequential run of digits.",
    ]);
    expect(pinPolicyProblems("98765432")).toEqual([
      "PIN cannot be a sequential run of digits.",
    ]);
  });

  it("lists length first so the store throws the same messages as before", () => {
    expect(pinPolicyProblems("11").length).toBeGreaterThan(0);
    expect(pinPolicyProblems("11")[0]).toBe("PIN must be 8–12 characters.");
    expect(() => assertPinPolicy("11111111")).toThrow(/repeated character/);
  });
});

describe("assertPinPolicy", () => {
  it("accepts a solid PIN", () => {
    expect(() => assertPinPolicy(PIN)).not.toThrow();
    expect(() =>
      assertPinPolicy(`${"x".repeat(MAX_PIN_LENGTH - 1)}y`),
    ).not.toThrow();
  });

  it("rejects PINs outside the length window", () => {
    expect(() => assertPinPolicy("x".repeat(MIN_PIN_LENGTH - 1))).toThrow(
      /8–12 characters/,
    );
    expect(() => assertPinPolicy("x".repeat(MAX_PIN_LENGTH + 1))).toThrow(
      /8–12 characters/,
    );
  });

  it("rejects whitespace, repetition, and digit runs", () => {
    expect(() => assertPinPolicy("4829 1037")).toThrow(/spaces/);
    expect(() => assertPinPolicy("11111111")).toThrow(/repeated character/);
    expect(() => assertPinPolicy("12345678")).toThrow(/sequential run/);
    expect(() => assertPinPolicy("98765432")).toThrow(/sequential run/);
    // Non-sequential but similar length still passes.
    expect(() => assertPinPolicy("13579246")).not.toThrow();
  });
});

describe("PIN unwrap guards", () => {
  it("rejects a wrap from an unknown KDF", async () => {
    const { rawVaultKey: raw } = await createVault(PASSWORD);
    const record = await wrapVaultKeyWithPin(raw, PIN);
    raw.fill(0);
    const tampered: PinUnlockRecord = overlapCast({
      ...record,
      kdf: { ...record.kdf, alg: "scrypt" },
    });
    await expect(unwrapVaultKeyWithPin(tampered, PIN)).rejects.toBeInstanceOf(
      VaultCorruptError,
    );
  });

  it("rejects derivation params below the floor", async () => {
    const { rawVaultKey: raw } = await createVault(PASSWORD);
    const record = await wrapVaultKeyWithPin(raw, PIN);
    raw.fill(0);
    const weakened = {
      ...record,
      kdf: { ...record.kdf, iterations: 1000 },
    };
    await expect(unwrapVaultKeyWithPin(weakened, PIN)).rejects.toBeInstanceOf(
      VaultCorruptError,
    );
  });

  it("rejects a PIN that fails policy before touching the wrap", async () => {
    const { rawVaultKey: raw } = await createVault(PASSWORD);
    const record = await wrapVaultKeyWithPin(raw, PIN);
    raw.fill(0);
    await expect(unwrapVaultKeyWithPin(record, "12345678")).rejects.toThrow(
      /sequential run/,
    );
  });
});

describe("WebAuthn PRF wrap", () => {
  async function prfWrap() {
    const { rawVaultKey: raw } = await createVault(PASSWORD);
    const prfOutput: ArrayBuffer = overlapCast(randomBytes(32).buffer);
    const prfSalt = randomBytes(16);
    const credentialId: ArrayBuffer = overlapCast(randomBytes(16).buffer);
    const userId: ArrayBuffer = overlapCast(randomBytes(16).buffer);
    const record = await wrapVaultKeyWithPrf(
      raw,
      prfOutput,
      prfSalt,
      credentialId,
      userId,
    );
    raw.fill(0);
    return { record, prfOutput };
  }

  it("round-trips the vault key through the PRF wrap", async () => {
    const { record, prfOutput } = await prfWrap();
    const raw = await unwrapVaultKeyWithPrf(record, prfOutput);
    const key = await importVaultKey(raw);
    raw.fill(0);
    expect(key.usages).toContain("encrypt");
  });

  it("rejects a different passkey's PRF output", async () => {
    const { record } = await prfWrap();
    const other: ArrayBuffer = overlapCast(randomBytes(32).buffer);
    await expect(unwrapVaultKeyWithPrf(record, other)).rejects.toBeInstanceOf(
      WrongPasswordError,
    );
  });

  it("records the credential id and user id for later ceremonies", async () => {
    const { record } = await prfWrap();
    expect(record.credentialIdB64).toBeTruthy();
    expect(record.userIdB64).toBeTruthy();
    expect(record.prfSaltB64).toBeTruthy();
  });
});

describe("exportRawVaultKey", () => {
  it("refuses a non-extractable key", async () => {
    const { vaultKey } = await createVault(PASSWORD);
    await expect(exportRawVaultKey(vaultKey)).rejects.toThrow(
      /not extractable/,
    );
  });

  it("exports an extractable key as bytes", async () => {
    const raw = randomBytes(32);
    const key = await crypto.subtle.importKey(
      "raw",
      overlapCast(raw),
      "AES-GCM",
      true,
      ["encrypt", "decrypt"],
    );
    const out = await exportRawVaultKey(key);
    expect(Array.from(out)).toEqual(Array.from(raw));
  });
});

describe("PRF extension results", () => {
  it("reads support and the first output defensively", () => {
    expect(prfExtensionSupported(undefined)).toBe(false);
    expect(prfExtensionSupported({})).toBe(false);
    expect(
      prfExtensionSupported(
        overlapCast({
          prf: { enabled: true },
        }),
      ),
    ).toBe(true);
    const first = overlapCast(randomBytes(32).buffer);
    expect(
      prfExtensionSupported(
        overlapCast({
          prf: { results: { first } },
        }),
      ),
    ).toBe(true);

    expect(readPrfFirst(undefined)).toBeNull();
    expect(readPrfFirst({})).toBeNull();
    expect(
      readPrfFirst(
        overlapCast({
          prf: { results: { first } },
        }),
      ),
    ).toBe(first);
  });
});

describe("TOTP gate secret", () => {
  it("opens what it seals under the vault key", async () => {
    const { vaultKey } = await createVault(PASSWORD);
    const gate = await sealTotpSecret(vaultKey, "JBSW Y3DP EHPK 3PXP");
    await expect(openTotpSecret(vaultKey, gate)).resolves.toBe(
      "JBSW Y3DP EHPK 3PXP",
    );
  });
});

describe("IP hostname detection", () => {
  it("recognises IPv4 and IPv6 literals, including bracketed", () => {
    expect(isIpHostname("127.0.0.1")).toBe(true);
    expect(isIpHostname("192.168.1.5")).toBe(true);
    expect(isIpHostname("::1")).toBe(true);
    expect(isIpHostname("[::1]")).toBe(true);
    expect(isIpHostname("example.com")).toBe(false);
    expect(isIpHostname("localhost")).toBe(false);
    expect(isIpHostname("  ")).toBe(false);
  });
});

describe("WebAuthn host preflight extras", () => {
  it("flags non-loopback IPs without offering a localhost hop", () => {
    const check = checkWebauthnHost(
      "192.168.1.5",
      "http://192.168.1.5:5180/settings",
    );
    expect(check.ok).toBe(false);
    expect(check.fixUrl).toBeNull();
    expect(check.reason).toMatch(/192\.168\.1\.5/);
  });

  it("offers a localhost hop for IPv6 loopback", () => {
    const check = checkWebauthnHost("::1", "http://[::1]:5180/settings");
    expect(check.ok).toBe(false);
    expect(check.fixUrl).toBe("http://localhost:5180/settings");
    expect(check.reason).toMatch(/loopback IP/i);
  });

  it("formats the error with or without a fix URL", () => {
    const withFix = checkWebauthnHost("127.0.0.1", "http://127.0.0.1:5180/");
    expect(formatWebauthnHostError(withFix)).toContain(
      "http://localhost:5180/",
    );
    const withoutFix = checkWebauthnHost("10.0.0.8", "http://10.0.0.8/");
    expect(formatWebauthnHostError(withoutFix)).toMatch(/hostname/);
  });

  it("assertWebauthnHost throws a WebauthnHostError carrying the check", () => {
    vi.stubGlobal("window", {
      location: { hostname: "10.0.0.8", href: "http://10.0.0.8:5180/" },
    });
    try {
      assertWebauthnHost();
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(WebauthnHostError);
      if (!(error instanceof WebauthnHostError)) throw error;
      expect(error.name).toBe("WebauthnHostError");
      expect(error.check.hostname).toBe("10.0.0.8");
      expect(error.message).toBe(formatWebauthnHostError(error.check));
    }
  });

  it("localhostEquivalentHref only rewrites loopback IP tabs", () => {
    expect(localhostEquivalentHref("http://127.0.0.1:5180/a")).toBe(
      "http://localhost:5180/a",
    );
    expect(localhostEquivalentHref("https://vault.example.com/a")).toBeNull();
  });
});

describe("describeWebauthnError mapping", () => {
  it("maps each well-known browser failure", () => {
    expect(describeWebauthnError("not an error")).toBe(
      "Passkey ceremony failed.",
    );
    expect(
      describeWebauthnError(new DOMException("cancelled", "NotAllowedError")),
    ).toMatch(/cancelled or timed out/);
    expect(
      describeWebauthnError(new DOMException("dup", "InvalidStateError")),
    ).toMatch(/already exist/);
    expect(
      describeWebauthnError(new DOMException("nope", "NotSupportedError")),
    ).toMatch(/does not support/);
    expect(
      describeWebauthnError(
        new Error(
          "Could not establish connection. Receiving end does not exist.",
        ),
      ),
    ).toMatch(/passkey extension disconnected.*Reload this page/i);
    expect(describeWebauthnError(new Error("  "))).toBe(
      "Passkey ceremony failed.",
    );
    expect(describeWebauthnError(new Error("something else"))).toBe(
      "something else",
    );
  });

  it("keeps a WebauthnHostError's own message", () => {
    const check = checkWebauthnHost("10.0.0.8", "http://10.0.0.8/");
    const error = new WebauthnHostError(check);
    expect(describeWebauthnError(error)).toBe(error.message);
  });
});

describe("primary unlock bookkeeping", () => {
  it("counts and prefers across every enrolled method", async () => {
    const { header } = await createVault(PASSWORD);
    expect(primaryUnlockCount(header)).toBe(1);
    expect(primaryUnlockCount(null)).toBe(0);
    expect(preferredUnlockMethod(null)).toBeNull();

    const pinOnly: VaultHeader = overlapCast({
      ...header,
      wrap: undefined,
      kdf: undefined,
      unlocks: {
        pin: { kdf: header.kdf, wrap: header.wrap },
      },
    });
    expect(preferredUnlockMethod(pinOnly)).toBe("pin");
    expect(() => assertKeepsPrimaryUnlock(pinOnly, "pin")).toThrow(
      /at least one primary/,
    );
  });
});
