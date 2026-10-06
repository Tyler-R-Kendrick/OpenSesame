import { afterEach, beforeEach, expect, it } from "vitest";
import { kvSet } from "../kv.js";
import { tombFileKey } from "../vfs.js";
import { probeRetiredCredential } from "./index.js";
import vectors from "./protocol-vectors.json";
import { createRetiredCredentialFixture } from "./test-support.js";
let fixture: Awaited<ReturnType<typeof createRetiredCredentialFixture>>;
beforeEach(async () => {
  fixture = await createRetiredCredentialFixture();
});
afterEach(() => fixture.restore());
it("matches the cross-runtime Argon2id vectors using exact composed and decomposed bytes", async () => {
  for (const vector of vectors.vectors) {
    kvSet(
      tombFileKey("personal", "retired-credentials.v1"),
      JSON.stringify({
        v: 1,
        tomb: "personal",
        events: [],
        traps: [
          {
            id: vector.name,
            createdAt: new Date().toISOString(),
            response: "reject",
            salt: vector.saltB64,
            verifier: vector.verifierB64,
          },
        ],
      }),
    );
    expect(
      (await probeRetiredCredential(vector.password, "personal"))?.id,
    ).toBe(vector.name);
  }
  expect(await probeRetiredCredential("é", "personal")).toBeNull();
});
