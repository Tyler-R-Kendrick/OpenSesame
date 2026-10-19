import { describe, expect, it } from "vitest";
import { generateClaimToken, parseClaimToken } from "./claim-token.js";

describe("generateClaimToken encoding", () => {
  it("emits unpadded base64url ids and secrets that round-trip", () => {
    const generated = generateClaimToken("pepper");
    // base64url alphabet only: no "+", "/" or "=" padding to strip.
    expect(generated.publicId).toMatch(/^[A-Za-z0-9_-]+$/u);
    expect(generated.secret).toMatch(/^[A-Za-z0-9_-]+$/u);
    expect(parseClaimToken(generated.token)).toEqual({
      publicId: generated.publicId,
      secret: generated.secret,
    });
  });

  it("encodes bytes whose base64 form needs padding without padding", () => {
    // 32 bytes encode to 44 base64 chars ending in "="; base64url omits it.
    const generated = generateClaimToken(
      "pepper",
      "fixed-id",
      Buffer.alloc(32, 0xff),
    );
    expect(generated.secret).not.toContain("=");
    expect(generated.secret).toBe(Buffer.alloc(32, 0xff).toString("base64url"));
  });
});
