import { describe, expect, it, vi } from "vitest";
import {
  WrongPasswordError,
  createVault,
  importVaultKey,
  openJson,
  sealJson,
} from "./crypto.js";
import { parseTotp, totpCode } from "./totp.js";
import {
  assertKeepsPrimaryUnlock,
  checkWebauthnHost,
  describeWebauthnError,
  listAvailableUnlockMethods,
  preferredUnlockMethod,
  randomTotpSecret,
  sealTotpSecret,
  totpCodeMatches,
  unwrapVaultKeyWithPin,
  webauthnRpId,
  wrapVaultKeyWithPin,
} from "./unlock-methods.js";

const PASSWORD = "correct horse battery staple";
const PIN = "48291037";

describe("unlock method listing", () => {
  it("lists password by default and prefers passkey when present", async () => {
    const { header } = await createVault(PASSWORD);
    expect(listAvailableUnlockMethods(header)).toEqual(["password"]);
    expect(preferredUnlockMethod(header)).toBe("password");

    const withPasskey = {
      ...header,
      unlocks: {
        passkey: {
          credentialIdB64: "YQ==",
          userIdB64: "YQ==",
          prfSaltB64: "YQ==",
          wrap: header.wrap!,
        },
        pin: {
          kdf: header.kdf!,
          wrap: header.wrap!,
        },
      },
    };
    expect(listAvailableUnlockMethods(withPasskey)).toEqual([
      "passkey",
      "pin",
      "password",
    ]);
    expect(preferredUnlockMethod(withPasskey)).toBe("passkey");
  });

  it("refuses removing the last primary method", async () => {
    const { header } = await createVault(PASSWORD);
    expect(() => assertKeepsPrimaryUnlock(header, "password")).toThrow(
      /at least one primary/,
    );
  });
});

describe("PIN wrap", () => {
  it("round-trips the vault key", async () => {
    const { vaultKey, rawVaultKey: raw } = await createVault(PASSWORD);
    const sealed = await sealJson(vaultKey, { via: "pin" });
    const record = await wrapVaultKeyWithPin(raw, PIN);
    raw.fill(0);

    const unwrapped = await unwrapVaultKeyWithPin(record, PIN);
    const reopened = await importVaultKey(unwrapped);
    unwrapped.fill(0);
    await expect(openJson(reopened, sealed)).resolves.toEqual({ via: "pin" });
  });

  it("rejects the wrong PIN", async () => {
    const { rawVaultKey: raw } = await createVault(PASSWORD);
    const record = await wrapVaultKeyWithPin(raw, PIN);
    raw.fill(0);
    await expect(
      unwrapVaultKeyWithPin(record, "48291038"),
    ).rejects.toBeInstanceOf(WrongPasswordError);
  });
});

describe("TOTP gate helpers", () => {
  it("verifies a live code against a sealed secret", async () => {
    const { vaultKey } = await createVault(PASSWORD);
    const secret = randomTotpSecret();
    const gate = await sealTotpSecret(vaultKey, secret);
    expect(gate.digits).toBe(6);
    const code = await totpCode(parseTotp(secret));
    await expect(totpCodeMatches(secret, code)).resolves.toBe(true);
    await expect(totpCodeMatches(secret, "000000")).resolves.toBe(false);
  });
});

describe("WebAuthn host preflight", () => {
  it("accepts DNS hostnames and localhost", () => {
    expect(checkWebauthnHost("localhost", "http://localhost:5180/").ok).toBe(
      true,
    );
    expect(
      checkWebauthnHost("pages.example.ts.net", "https://pages.example.ts.net/")
        .ok,
    ).toBe(true);
    expect(webauthnRpId("localhost")).toBe("localhost");
  });

  it("rejects loopback IPs and offers a localhost fix URL", () => {
    const check = checkWebauthnHost(
      "127.0.0.1",
      "http://127.0.0.1:5180/settings#unlock",
    );
    expect(check.ok).toBe(false);
    expect(check.fixUrl).toBe("http://localhost:5180/settings#unlock");
    expect(check.reason).toMatch(/loopback IP/i);
    expect(describeWebauthnError(new Error("This is an invalid domain."))).toMatch(
      /localhost|DNS hostname|invalid domain/i,
    );
  });

  it("maps Chrome SecurityError invalid-domain into remediation copy", () => {
    const err = new DOMException("This is an invalid domain.", "SecurityError");
    // Without a window, checkWebauthnHost defaults to localhost (ok), so we
    // still get actionable generic copy rather than the raw browser string.
    const message = describeWebauthnError(err);
    expect(message).not.toBe("This is an invalid domain.");
    expect(message).toMatch(/DNS hostname|localhost|passkeys/i);
  });

  it("includes a localhost hop when the tab is on 127.0.0.1", () => {
    vi.stubGlobal("window", {
      location: {
        hostname: "127.0.0.1",
        href: "http://127.0.0.1:5180/settings",
      },
    });
    try {
      const message = describeWebauthnError(
        new DOMException("This is an invalid domain.", "SecurityError"),
      );
      expect(message).toMatch(/loopback IP/i);
      expect(message).toContain("http://localhost:5180/settings");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("never returns an IP as the WebAuthn RP ID", () => {
    expect(webauthnRpId("127.0.0.1")).toBe("localhost");
    expect(webauthnRpId("::1")).toBe("localhost");
  });
});
