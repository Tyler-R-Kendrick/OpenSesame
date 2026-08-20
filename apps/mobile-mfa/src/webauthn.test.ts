import { describe, expect, it } from "vitest";
import {
  assertionPayload,
  b64urlToBytes,
  bytesToB64url,
  creationOptionsFromJson,
  registrationResponseJson,
  requestOptionsFromJson,
} from "./webauthn.js";
import { overlapCast } from "@opensesame/os-domain";

describe("webauthn b64url", () => {
  it("round-trips bytes", () => {
    const original = new Uint8Array([1, 2, 250, 255, 0]);
    const encoded = bytesToB64url(original);
    expect(encoded).not.toMatch(/[+/=]/);
    expect([...b64urlToBytes(encoded)]).toEqual([...original]);
  });

  it("accepts an ArrayBuffer input", () => {
    const bytes = new Uint8Array([104, 101, 108, 108, 111]);
    const encoded = bytesToB64url(bytes.buffer);
    expect(encoded).toBe("aGVsbG8");
  });

  it("decodes values needing one or two padding chars", () => {
    expect([...b64urlToBytes("aGVsbG8")]).toEqual([104, 101, 108, 108, 111]);
    expect([...b64urlToBytes("aGk")]).toEqual([104, 105]);
    expect([...b64urlToBytes("aA")]).toEqual([104]);
  });

  it("maps base64url - and _ back to + and / bytes", () => {
    // 0xfb 0xff encodes as -_ in base64url (+ / in standard base64)
    expect([...b64urlToBytes("-_8")]).toEqual([251, 255]);
  });
});

describe("creationOptionsFromJson", () => {
  it("converts challenge and user.id to bytes", () => {
    const opts = creationOptionsFromJson({
      rp: { name: "OpenSesame" },
      user: { id: "aA", name: "dev@example", displayName: "Dev" },
      challenge: "aGk",
      pubKeyCredParams: [{ type: "public-key", alg: -7 }],
    });
    const pk = overlapCast(opts.publicKey);
    expect([...(overlapCast(pk.challenge))]).toEqual([104, 105]);
    expect([...(overlapCast(pk.user.id))]).toEqual([104]);
    expect(pk.user.name).toBe("dev@example");
    expect(pk.excludeCredentials).toBeUndefined();
  });

  it("converts excludeCredentials ids to bytes", () => {
    const opts = creationOptionsFromJson({
      rp: { name: "OpenSesame" },
      user: { id: "aA", name: "dev@example", displayName: "Dev" },
      challenge: "aGk",
      pubKeyCredParams: [],
      excludeCredentials: [
        { id: "aGVsbG8", type: "public-key", transports: ["internal"] },
      ],
    });
    const pk = overlapCast(opts.publicKey);
    expect(pk.excludeCredentials).toHaveLength(1);
    const first = pk.excludeCredentials?.[0];
    expect([...(overlapCast(first?.id))]).toEqual([104, 101, 108, 108, 111]);
    expect(first?.type).toBe("public-key");
    expect(first?.transports).toEqual(["internal"]);
  });
});

describe("requestOptionsFromJson", () => {
  it("converts challenge to bytes and omits allowCredentials", () => {
    const opts = requestOptionsFromJson({ challenge: "aGk" });
    const pk = overlapCast(opts.publicKey);
    expect([...(overlapCast(pk.challenge))]).toEqual([104, 105]);
    expect(pk.allowCredentials).toBeUndefined();
  });

  it("converts allowCredentials ids to bytes", () => {
    const opts = requestOptionsFromJson({
      challenge: "aGk",
      rpId: "id.opensesame.test",
      userVerification: "required",
      allowCredentials: [{ id: "aA", type: "public-key" }],
    });
    const pk = overlapCast(opts.publicKey);
    expect(pk.rpId).toBe("id.opensesame.test");
    const first = pk.allowCredentials?.[0];
    expect([...(overlapCast(first?.id))]).toEqual([104]);
  });
});

describe("registrationResponseJson", () => {
  it("serializes the attestation response with transports", () => {
    const cred = overlapCast({
      id: "cred-1",
      rawId: new Uint8Array([1, 2, 3]).buffer,
      type: "public-key",
      response: {
        clientDataJSON: new Uint8Array([9]).buffer,
        attestationObject: new Uint8Array([8, 7]).buffer,
        getTransports: () => ["internal", "hybrid"],
      },
      getClientExtensionResults: () => ({ credProps: { rk: true } }),
    });
    const json = registrationResponseJson(cred);
    expect(json).toEqual({
      id: "cred-1",
      rawId: "AQID",
      type: "public-key",
      response: {
        clientDataJSON: "CQ",
        attestationObject: "CAc",
        transports: ["internal", "hybrid"],
      },
      clientExtensionResults: { credProps: { rk: true } },
    });
  });

  it("defaults transports to [] when getTransports is missing", () => {
    const cred = overlapCast({
      id: "cred-2",
      rawId: new Uint8Array([1]).buffer,
      type: "public-key",
      response: {
        clientDataJSON: new Uint8Array([0]).buffer,
        attestationObject: new Uint8Array([0]).buffer,
      },
      getClientExtensionResults: () => ({}),
    });
    expect(registrationResponseJson(cred).response.transports).toEqual([]);
  });
});

describe("assertionPayload", () => {
  it("serializes the assertion response", () => {
    const cred = overlapCast({
      id: "cred-1",
      response: {
        clientDataJSON: new Uint8Array([1]).buffer,
        authenticatorData: new Uint8Array([2, 3]).buffer,
        signature: new Uint8Array([250, 255]).buffer,
      },
    });
    expect(assertionPayload(cred)).toEqual({
      credentialId: "cred-1",
      clientDataJSON: "AQ",
      authenticatorData: "AgM",
      signature: "-v8",
    });
  });
});
