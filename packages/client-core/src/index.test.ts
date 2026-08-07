import { describe, expect, it } from "vitest";
import { bytesToB64, createCursor, sealDevOnly } from "./index.js";

describe("client-core js facade", () => {
  it("creates cursor", () => {
    expect(createCursor("d1").epoch).toBe(0);
  });

  it("does not embed plaintext in b64 of sealed bytes", () => {
    const key = new Uint8Array(32).fill(7);
    const sealed = sealDevOnly(new TextEncoder().encode("secret-note"), key);
    const b64 = bytesToB64(sealed);
    expect(b64.includes("secret")).toBe(false);
  });
});
