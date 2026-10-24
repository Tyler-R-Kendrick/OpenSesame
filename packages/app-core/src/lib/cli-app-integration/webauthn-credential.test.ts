import {
  type JsonValue,
  overlapCast,
  readJsonObject,
  readString,
} from "@opensesame/os-domain";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { b64urlDecode, b64urlEncode } from "./device-crypto.js";
import {
  assertStoredCliAppPasskey,
  clearCliAppWebAuthnCredential,
  coseP256ToSpki,
  createCliAppPasskeyCredential,
  ecdsaDerToP1363,
  encodeCoseP256,
  saveCliAppWebAuthnCredential,
} from "./webauthn-credential.js";

function bytesOf(source: BufferSource): Uint8Array {
  if (source instanceof ArrayBuffer) return new Uint8Array(source);
  return new Uint8Array(source.buffer, source.byteOffset, source.byteLength);
}

function same(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false;
  for (let i = 0; i < left.length; i += 1) {
    if (left[i] !== right[i]) return false;
  }
  return true;
}

function memoryStorage(): Storage {
  const items = new Map<string, string>();
  return {
    get length() {
      return items.size;
    },
    clear() {
      items.clear();
    },
    getItem(key: string) {
      return items.get(key) ?? null;
    },
    key(index: number) {
      return [...items.keys()][index] ?? null;
    },
    removeItem(key: string) {
      items.delete(key);
    },
    setItem(key: string, value: string) {
      items.set(key, value);
    },
  };
}

beforeEach(() => {
  vi.stubGlobal("localStorage", memoryStorage());
});

afterEach(async () => {
  await clearCliAppWebAuthnCredential();
  vi.unstubAllGlobals();
});

describe("CLI WebAuthn credential", () => {
  it("round-trips a P-256 COSE key to SPKI and a DER signature to raw r||s", () => {
    const x = new Uint8Array(32).fill(3);
    const y = new Uint8Array(32).fill(9);
    const cose = encodeCoseP256(x, y);
    expect(cose).not.toBeNull();
    const spki = coseP256ToSpki(cose ?? new Uint8Array());
    expect(spki).not.toBeNull();
    expect(spki?.[spki.length - 65]).toBe(0x04);
    expect(
      same(
        spki?.subarray(spki.length - 64, spki.length - 32) ?? new Uint8Array(),
        x,
      ),
    ).toBe(true);
    expect(same(spki?.subarray(spki.length - 32) ?? new Uint8Array(), y)).toBe(
      true,
    );

    const raw = new Uint8Array(64).fill(4);
    expect(ecdsaDerToP1363(raw)).toBe(raw);
    const der = Uint8Array.from([
      0x30, 0x08, 0x02, 0x02, 0x00, 0x01, 0x02, 0x02, 0x00, 0x02,
    ]);
    const p1363 = ecdsaDerToP1363(der);
    expect(p1363?.length).toBe(64);
    expect(p1363?.[31]).toBe(1);
    expect(p1363?.[63]).toBe(2);
  });

  it("registers the authenticator rawId and asks approval to allow that id", async () => {
    const rawId = crypto.getRandomValues(new Uint8Array(16));
    const x = new Uint8Array(32).fill(7);
    const y = new Uint8Array(32).fill(8);
    const cose = encodeCoseP256(x, y);
    const spki = coseP256ToSpki(cose ?? new Uint8Array());
    expect(spki).not.toBeNull();
    const authData = new Uint8Array(37);
    authData[32] = 0x05;
    authData[36] = 1;
    const der = Uint8Array.from([
      0x30, 0x08, 0x02, 0x02, 0x00, 0x01, 0x02, 0x02, 0x00, 0x02,
    ]);
    const created = {
      type: "public-key",
      rawId: rawId.buffer.slice(
        rawId.byteOffset,
        rawId.byteOffset + rawId.byteLength,
      ),
      response: {
        getPublicKey: () => spki,
        getAuthenticatorData: () => authData,
        attestationObject: new ArrayBuffer(0),
        clientDataJSON: new ArrayBuffer(0),
      },
    };
    const asserted = {
      type: "public-key",
      rawId: created.rawId,
      response: {
        authenticatorData: authData,
        clientDataJSON: new TextEncoder().encode(
          JSON.stringify({ type: "webauthn.get", challenge: "abc" }),
        ),
        signature: der,
      },
    };
    let allowId: BufferSource | undefined;
    const credentials = {
      // The fakes carry only the members a ceremony reads.
      create: async (): Promise<Credential> => overlapCast(created),
      get: async (options: CredentialRequestOptions): Promise<Credential> => {
        allowId = options.publicKey?.allowCredentials?.[0]?.id;
        return overlapCast(asserted);
      },
    };
    vi.stubGlobal("location", { hostname: "localhost" });
    const challenge = crypto.getRandomValues(new Uint8Array(32));
    const registered = await createCliAppPasskeyCredential(
      challenge,
      credentials,
    );
    expect(registered.ok).toBe(true);
    if (!registered.ok) return;
    expect(registered.credentialIdB64).toBe(b64urlEncode(rawId));
    expect(registered.credentialIdB64).not.toBe(
      b64urlEncode(spki ?? new Uint8Array()),
    );
    expect(allowId).toBeTruthy();
    expect(same(bytesOf(allowId ?? new Uint8Array()), rawId)).toBe(true);
    expect(registered.humanProof.startsWith("oschip2:passkey:")).toBe(true);
    const wire: JsonValue = JSON.parse(
      registered.humanProof.slice("oschip2:passkey:".length),
    );
    const signature = readString(readJsonObject(wire)?.signatureB64);
    expect(b64urlDecode(signature ?? "")?.length).toBe(64);
    const storedCose = b64urlDecode(registered.coseKeyB64);
    expect(
      storedCose &&
        same(
          coseP256ToSpki(storedCose) ?? new Uint8Array(),
          spki ?? new Uint8Array(),
        ),
    ).toBe(true);

    await saveCliAppWebAuthnCredential({
      credentialIdB64: registered.credentialIdB64,
      coseKeyB64: registered.coseKeyB64,
      publicKeySpkiB64: registered.publicKeySpkiB64,
    });
    let approvalId: BufferSource | undefined;
    const approval = await assertStoredCliAppPasskey(challenge, {
      create: async () => null,
      get: async (options: CredentialRequestOptions): Promise<Credential> => {
        approvalId = options.publicKey?.allowCredentials?.[0]?.id;
        return overlapCast(asserted);
      },
    });
    expect(approval.ok).toBe(true);
    if (!approval.ok) return;
    expect(approval.proof.startsWith("oschip3:passkey:")).toBe(true);
    expect(same(bytesOf(approvalId ?? new Uint8Array()), rawId)).toBe(true);
  });

  it("refuses approval before asking for a passkey when none is stored", async () => {
    const get = vi.fn();
    const result = await assertStoredCliAppPasskey(new Uint8Array(32), {
      create: async () => null,
      get,
    });
    expect(result).toMatchObject({ ok: false, code: "passkey_missing" });
    expect(get).not.toHaveBeenCalled();
  });
});
