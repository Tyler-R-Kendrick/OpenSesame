import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { verifyTargets } from "../../scripts/emit-connect-verify-targets.mjs";
import { VERIFY_TARGETS } from "../connect-verify-targets.generated.mjs";
import {
  resolveTarget,
  verifyTargetFor,
  verifyWithToken,
} from "../connect-verify.mjs";

const TOKEN = "provider_token_that_must_never_leave_the_relay";

describe("token proof boundaries", () => {
  it("skips a target whose host still names a placeholder", async () => {
    const result = await verifyWithToken(
      {
        kind: "oauth",
        method: "GET",
        url: "https://{domain}/me",
        header: "Authorization",
        scheme: "Bearer",
      },
      TOKEN,
      () => assert.fail("must not fetch"),
    );
    assert.equal(result, null);
  });

  it("reads a large 2xx answer as an answer, not a refusal", async () => {
    const big = JSON.stringify({ items: "x".repeat(200_000) });
    const target = {
      kind: "oauth",
      method: "GET",
      url: "https://api.example/me",
      header: "Authorization",
      scheme: "Bearer",
    };
    const ok = await verifyWithToken(
      target,
      TOKEN,
      async () => new Response(big, { status: 200 }),
    );
    assert.equal(ok.ok, true);
    const refused = await verifyWithToken(
      target,
      TOKEN,
      async () => new Response(big, { status: 401 }),
    );
    assert.equal(refused.ok, false);
  });

  it("sends the token only to the host that issued it", () => {
    const target = VERIFY_TARGETS.okta.oauth;
    const connector = (authorize, token) => ({
      service: "okta",
      type: "oauth",
      data: {
        serverConfig: {
          authorization_endpoint: authorize,
          token_endpoint: token,
        },
      },
    });
    const real = resolveTarget(
      target,
      connector(
        "https://acme.okta.com/oauth2/v1/authorize",
        "https://acme.okta.com/oauth2/v1/token",
      ),
    );
    assert.equal(new URL(real.url).host, "acme.okta.com");
    // An edited authorization endpoint cannot redirect the proof.
    const steered = resolveTarget(
      target,
      connector(
        "https://attacker.example/oauth2/v1/authorize",
        "https://acme.okta.com/oauth2/v1/token",
      ),
    );
    assert.match(steered.url, /\{domain\}/);
    // Nor can a token endpoint the preset's template does not recognise.
    const unknown = resolveTarget(
      target,
      connector(
        "https://acme.okta.com/oauth2/v1/authorize",
        "https://x.test/t",
      ),
    );
    assert.match(unknown.url, /\{domain\}/);
  });

  it("chooses the API-key call for an API-key connector", () => {
    const withKey = Object.entries(VERIFY_TARGETS).find(
      ([, row]) => row.apiKey,
    );
    if (!withKey) return;
    const [id, row] = withKey;
    assert.equal(verifyTargetFor({ service: id, type: "api-key" }), row.apiKey);
  });
});

describe("generated verify targets", () => {
  it("match the specs", () => {
    assert.deepEqual(
      JSON.parse(JSON.stringify(VERIFY_TARGETS)),
      verifyTargets(),
    );
  });

  it("are all https", () => {
    for (const row of Object.values(VERIFY_TARGETS)) {
      for (const target of Object.values(row)) {
        assert.equal(
          new URL(target.url.replace(/\{[a-z_]+\}/, "x")).protocol,
          "https:",
        );
      }
    }
  });
});
