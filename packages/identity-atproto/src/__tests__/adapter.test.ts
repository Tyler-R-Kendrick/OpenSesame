import { describe, expect, it } from "vitest";
import { createDisabledAtprotoAdapter } from "../index.js";

describe("identity-atproto", () => {
  it("is disabled by default", async () => {
    const a = createDisabledAtprotoAdapter();
    expect(a.enabled).toBe(false);
    await expect(a.verifySession({ did: "did:plc:x" })).rejects.toThrow(
      /disabled/,
    );
  });
});
