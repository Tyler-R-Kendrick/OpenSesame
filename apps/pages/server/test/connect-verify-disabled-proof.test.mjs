import assert from "node:assert/strict";
import { test } from "node:test";
import { verifyTargets } from "../../scripts/emit-connect-verify-targets.mjs";
import { VERIFY_TARGETS } from "../connect-verify-targets.generated.mjs";
import { resolveTarget, verifyWithToken } from "../connect-verify.mjs";

test("a shared proof stays bound when public flags change", async () => {
  const target = VERIFY_TARGETS["fal-ai"].apiKey;
  assert.equal(target.unbound, false);
  const resolved = resolveTarget(target, { data: {} });
  try {
    target.unbound = true;
    resolved.unbound = true;
    for (const candidate of [target, resolved]) {
      const result = await verifyWithToken(candidate, "synthetic-token", () =>
        Response.json({ openapi: "3.1.0" }),
      );
      assert.equal(result.ok, true);
    }
  } finally {
    target.unbound = false;
  }
});

test("structural copies of bound targets cannot become unbound destinations", async () => {
  const target = VERIFY_TARGETS["fal-ai"].apiKey;
  const resolved = resolveTarget(target, { data: {} });
  for (const copy of [
    { ...target, url: "https://{domain}/openapi.json" },
    { ...resolved, url: "https://{domain}/openapi.json" },
  ]) {
    assert.equal(
      await verifyWithToken(copy, "synthetic-token", () =>
        assert.fail("must not fetch"),
      ),
      null,
    );
  }
});

test("Higgsfield's key ID and secret pair has no single-key relay proof", () => {
  // Its contract fills `Key {key}:{key_secret}`; the relay holds one token.
  assert.equal(VERIFY_TARGETS.higgsfield?.apiKey, undefined);
});

test("a status-proof contract is refused rather than judged by body", () => {
  const row = {
    service: "status-proof",
    header: "Authorization",
    scheme: "Bearer",
    service_urls: ["https://api.example.com"],
    verify: {
      method: "GET",
      url: "https://api.example.com/requests/x/status",
      account_field: null,
      valid_statuses: [404],
    },
  };
  assert.throws(
    () => verifyTargets({ services: [] }, { oauth: [], api_key: [row] }),
    /status/,
  );
});
