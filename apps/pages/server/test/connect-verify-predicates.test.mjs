import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { VERIFY_TARGETS } from "../connect-verify-targets.generated.mjs";
import { verifyWithToken } from "../connect-verify.mjs";

const TOKEN = "synthetic-provider-proof-token";

async function check(service, body) {
  const target = VERIFY_TARGETS[service].apiKey;
  assert.ok(target);
  return verifyWithToken(target, TOKEN, async () => Response.json(body));
}

describe("provider-declared HTTP 200 verification predicates", () => {
  it("rejects inactive Cloudflare tokens even when the API request succeeded", async () => {
    const result = { id: "token-id", status: "active" };
    assert.equal(
      (await check("cloudflare", { success: true, result })).ok,
      true,
    );
    assert.equal(
      (
        await check("cloudflare", {
          success: true,
          result: { ...result, status: "disabled" },
        })
      ).ok,
      false,
    );
    assert.equal(
      (await check("cloudflare", { success: false, result })).ok,
      false,
    );
    assert.equal(
      (await check("cloudflare", { success: true, result, errors: ["denied"] }))
        .ok,
      false,
    );
    assert.equal(
      (
        await check("cloudflare", {
          success: true,
          result: { status: "active" },
        })
      ).ok,
      false,
    );
  });

  it("rejects invalid Datadog single API keys without returning an account claim", async () => {
    const valid = await check("datadog", { valid: true });
    assert.deepEqual(valid, { status: 200, ok: true, account: "" });
    assert.equal((await check("datadog", { valid: false })).ok, false);
    assert.equal((await check("datadog", { valid: "true" })).ok, false);
    assert.equal(
      (await check("datadog", { valid: true, error: "denied" })).ok,
      false,
    );
  });

  it("requires Sanity's actual identity field and rejects anonymous nonempty replies", async () => {
    assert.equal((await check("sanity", { id: "real-id" })).ok, true);
    for (const body of [{ name: "anonymous" }, { id: "" }, { id: null }])
      assert.equal((await check("sanity", body)).ok, false);
  });

  it("refuses account fields that reflect the credential before truncating display text", async () => {
    const key = "private-proof-token-".repeat(10);
    const result = await verifyWithToken(
      VERIFY_TARGETS.sanity.apiKey,
      key,
      async () => Response.json({ id: `provider reflected ${key}` }),
    );
    assert.deepEqual(result, { status: 200, ok: false, account: "" });
  });

  it("refuses GraphQL errors and missing declared identity fields", async () => {
    assert.equal(
      (
        await check("linear", {
          data: { viewer: { id: "user-id", name: "Alice" } },
        })
      ).ok,
      true,
    );
    assert.equal(
      (await check("linear", { data: { viewer: { name: "Alice" } } })).ok,
      false,
    );
    assert.equal(
      (await check("linear", { errors: [{ message: "denied" }] })).ok,
      false,
    );
  });

  it("does not turn a truncated semantic proof into a successful verification", async () => {
    const result = await verifyWithToken(
      VERIFY_TARGETS.cloudflare.apiKey,
      TOKEN,
      async () =>
        Response.json({
          success: true,
          result: { id: "id", status: "active" },
          padding: "x".repeat(100000),
        }),
    );
    assert.equal(result.ok, false);
  });
});
