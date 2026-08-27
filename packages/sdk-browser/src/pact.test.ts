import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { overlapCast } from "@opensesame/os-domain";
import { assertSourceOrder } from "@opensesame/testing";
import { describe, expect, it } from "vitest";
import { createOpenSesame } from "./client.js";

const here = dirname(fileURLToPath(import.meta.url));

describe("PACT — browser SDK claim complete", () => {
  it("does not log WebAuthn assertion bytes", () => {
    const src = readFileSync(join(here, "webauthn.ts"), "utf8");
    expect(src).not.toMatch(/console\.(log|debug|info)/);
    expect(src).toContain("bytesToB64url");
  });
  it("sends claimToken on complete after encoding the path id", () => {
    assertSourceOrder(readFileSync(join(here, "client.ts"), "utf8"), [
      "async completeClaim",
      "encodeURIComponent(claimId)",
      "body.claimToken = decision.claimToken",
      'headers["x-claim-token"] = decision.claimToken',
    ]);
  });

  it("chaos: completeClaim without a session fails closed", async () => {
    const sesame = createOpenSesame({
      issuer: "http://127.0.0.1:8788",
      storage: {
        getItem: () => null,
        setItem: () => {},
        removeItem: () => {},
      },
      fetchImpl: overlapCast(async () => {
        throw new Error("network must not be reached");
      }),
    });
    await expect(
      sesame.completeClaim("clm_1", {
        acceptedItemIds: [],
        userCode: "WORD-WORD",
      }),
    ).rejects.toThrow(/Authentication required/);
  });
});
