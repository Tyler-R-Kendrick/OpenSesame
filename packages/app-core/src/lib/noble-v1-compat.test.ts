import { ecb, gcm } from "@noble/ciphers/aes.js";
import { b64urlToBytes, bytesToB64url } from "@opensesame/vault-core";
import { describe, expect, it } from "vitest";
import { atRestBinding, openAtRest } from "./at-rest/cipher.js";
import { openBitwardenEncString } from "./secret-backends/bitwarden-native-envelope.js";
import { b64, decryptRecord } from "./sops/aes-record.js";

// Synthetic fixtures generated with @noble/ciphers 1.3.0 before the v2 upgrade.
const key = Uint8Array.from({ length: 32 }, (_, index) => index);
const plaintext = new TextEncoder().encode("historical secret");
const sops =
  "ENC[AES256_GCM,data:wdGB8q3Nd6aK+jZinf/X2WI=,iv:oKGio6SlpqeoqaqrrK2ur7CxsrO0tba3uLm6u7y9vr8=,tag:NL/84f40mQHI6+ic5rwYtA==,type:str]";
const legacy =
  "osr1.QEFCQ0RFRkdISUpLTE1OT1BRUlNUVVZXvFB2BL-SEHXumKfNyv8X9-Y5c44XwHsO0WFWh4D25G9_";
const bitwarden =
  "2.oKGio6SlpqeoqaqrrK2urw==|xb+03WDaBF5aTrO5UFCOD3j4rRb5bY0suGqi7b28Uik=|YCi4gG7lP80PQepWkybAsl0b4YUEPiqxMAs4Qt3hkLE=";

describe("cipher upgrade compatibility", () => {
  it("opens and reproduces SOPS GCM with the full 32-byte nonce", () => {
    expect(decryptRecord(sops, key, "database:password:")).toEqual({
      kind: "str",
      value: "historical secret",
    });
    const nonce = Uint8Array.from({ length: 32 }, (_, index) => 0xa0 + index);
    const aad = new TextEncoder().encode("database:password:");
    const sealed = gcm(key, nonce, aad).encrypt(plaintext);
    expect(b64(sealed.subarray(0, -16))).toBe("wdGB8q3Nd6aK+jZinf/X2WI=");
    expect(b64(sealed.subarray(-16))).toBe("NL/84f40mQHI6+ic5rwYtA==");
    expect(() => decryptRecord(sops, key, "database:wrong:")).toThrow();
    expect(() =>
      decryptRecord(sops.replace("NL/84", "ML/84"), key, "database:password:"),
    ).toThrow();
  });

  it("opens a historical at-rest envelope and rejects tampering and rebinding", () => {
    const binding = atRestBinding("customer-a", "vault/secret");
    expect(openAtRest(key, binding, legacy)).toBe("historical secret");
    expect(
      openAtRest(key, atRestBinding("customer-b", "vault/secret"), legacy),
    ).toBeNull();
    const bytes = b64urlToBytes(legacy.slice(5));
    bytes[bytes.length - 1] ^= 1;
    expect(openAtRest(key, binding, `osr1.${bytesToB64url(bytes)}`)).toBeNull();
  });

  it("opens a historical authenticated Bitwarden CBC envelope", () => {
    const key64 = Uint8Array.from({ length: 64 }, (_, index) => index);
    expect(openBitwardenEncString(bitwarden, key64)).toEqual(plaintext);
    expect(() =>
      openBitwardenEncString(bitwarden.replace("xb+03", "yb+03"), key64),
    ).toThrow();
    key64[32] ^= 1;
    expect(() => openBitwardenEncString(bitwarden, key64)).toThrow();
  });

  it("preserves the unpadded AES-ECB primitive used by XAES", () => {
    const input = Uint8Array.from({ length: 32 }, (_, index) => 0x20 + index);
    const output = ecb(key, { disablePadding: true }).encrypt(input);
    expect(
      Array.from(output, (byte) => byte.toString(16).padStart(2, "0")).join(""),
    ).toBe("61a6936e4e8f101c1cc1f993b542a0d4e2740e8afad4e4d15d0d661b382eca89");
  });
});
