import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { assertSourceOrder } from "@opensesame/testing";
import { createOpenSesame } from "./client.js";

const here = dirname(fileURLToPath(import.meta.url));

describe("PACT — browser SDK claim complete", () => {
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
      fetchImpl: (async () => {
        throw new Error("network must not be reached");
      }) as unknown as typeof fetch,
    });
    await expect(
      sesame.completeClaim("clm_1", { acceptedItemIds: [] }),
    ).rejects.toThrow(/Authentication required/);
  });
});
