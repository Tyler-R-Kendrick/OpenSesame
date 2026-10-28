import assert from "node:assert/strict";
import { test } from "node:test";
import { VERIFY_TARGETS } from "../connect-verify-targets.generated.mjs";
import { resolveTarget, verifyWithToken } from "../connect-verify.mjs";

test("the unpublished Higgsfield proof stays disabled even if public fields change", async () => {
  const target = VERIFY_TARGETS.higgsfield.apiKey;
  assert.equal(target.proofDisabled, true);
  const resolved = resolveTarget(target, { data: {} });
  try {
    target.proofDisabled = false;
    resolved.proofDisabled = false;
    for (const candidate of [target, resolved])
      assert.equal(
        await verifyWithToken(candidate, "synthetic-token", () =>
          assert.fail("must not fetch"),
        ),
        null,
      );
  } finally {
    target.proofDisabled = true;
  }
});

test("structural copies of disabled Higgsfield targets stay closed", async () => {
  const target = VERIFY_TARGETS.higgsfield.apiKey;
  const resolved = resolveTarget(target, { data: {} });
  for (const copy of [{ ...target }, { ...resolved }]) {
    assert.equal(
      await verifyWithToken(copy, "synthetic-token", () =>
        assert.fail("must not fetch"),
      ),
      null,
    );
  }
});
