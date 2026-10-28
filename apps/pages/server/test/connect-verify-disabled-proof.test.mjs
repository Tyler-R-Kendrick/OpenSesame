import assert from "node:assert/strict";
import { test } from "node:test";
import { VERIFY_TARGETS } from "../connect-verify-targets.generated.mjs";
import { resolveTarget, verifyWithToken } from "../connect-verify.mjs";

test("the shared Higgsfield proof stays bound when public flags change", async () => {
  const target = VERIFY_TARGETS.higgsfield.apiKey;
  assert.equal(target.unbound, false);
  const resolved = resolveTarget(target, { data: {} });
  try {
    target.unbound = true;
    resolved.unbound = true;
    for (const candidate of [target, resolved]) {
      const result = await verifyWithToken(candidate, "synthetic-token", () =>
        Response.json({ models: [] }),
      );
      assert.equal(result.ok, true);
    }
  } finally {
    target.unbound = false;
  }
});

test("structural copies of bound Higgsfield targets cannot become unbound destinations", async () => {
  const target = VERIFY_TARGETS.higgsfield.apiKey;
  const resolved = resolveTarget(target, { data: {} });
  for (const copy of [
    { ...target, url: "https://{domain}/v1/models" },
    { ...resolved, url: "https://{domain}/v1/models" },
  ]) {
    assert.equal(
      await verifyWithToken(copy, "synthetic-token", () =>
        assert.fail("must not fetch"),
      ),
      null,
    );
  }
});
