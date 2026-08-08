import { describe, expect, it } from "vitest";
import { b64urlToBytes, bytesToB64url } from "./webauthn.js";

describe("webauthn b64url", () => {
  it("round-trips bytes", () => {
    const original = new Uint8Array([1, 2, 250, 255, 0]);
    const encoded = bytesToB64url(original);
    expect(encoded).not.toMatch(/[+/=]/);
    expect([...b64urlToBytes(encoded)]).toEqual([...original]);
  });
});
