import assert from "node:assert/strict";
import { test } from "node:test";
import { VERIFY_TARGETS } from "../connect-verify-targets.generated.mjs";
import {
  resolveTarget,
  verifyTargetFor,
  verifyWithToken,
} from "../connect-verify.mjs";

test("the single-key relay refuses Higgsfield's multi-secret status proof", async () => {
  assert.equal(VERIFY_TARGETS.higgsfield, undefined);
  const target = verifyTargetFor({
    service: "higgsfield",
    type: "api-key",
    data: {},
  });
  assert.equal(target, null);
  assert.equal(
    await verifyWithToken(target, "synthetic-token", () =>
      assert.fail("must not fetch"),
    ),
    null,
  );
});

test("structural copies of disabled proofs stay closed", async () => {
  const target = { url: "https://example.test/status", proofDisabled: true };
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
