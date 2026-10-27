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
});

describe("what a verify answer says", () => {
  it("reads Slack's 200 with ok:false as the refusal it is", async () => {
    const target = VERIFY_TARGETS.slack?.oauth ?? {
      kind: "oauth",
      method: "GET",
      url: "https://slack.com/api/auth.test",
      header: "Authorization",
      scheme: "Bearer",
    };
    const revoked = await verifyWithToken(target, TOKEN, async () =>
      Response.json({ ok: false, error: "invalid_auth" }),
    );
    assert.equal(revoked.status, 200);
    assert.equal(revoked.ok, false);
    const live = await verifyWithToken(target, TOKEN, async () =>
      Response.json({ ok: true, user: "alice" }),
    );
    assert.equal(live.ok, true);
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
});

describe("where the token goes", () => {
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

  it("binds shared-host OAuth aliases by UID without cross-provider routing", () => {
    const drive = verifyTargetFor({
      service: "accounts.google.com",
      uid: "google-drive/default",
      data: {},
    });
    assert.equal(drive.url, "https://www.googleapis.com/oauth2/v3/userinfo");
    const m365 = verifyTargetFor({
      service: "login.microsoftonline.com",
      uid: "m365/default",
      data: {},
    });
    assert.equal(m365.accountField, "displayName");
    assert.equal(
      verifyTargetFor({
        service: "accounts.google.com",
        uid: "unlisted/default",
        data: {},
      }).url,
      "https://openidconnect.googleapis.com/v1/userinfo",
    );
    assert.equal(
      verifyTargetFor({
        service: "login.microsoftonline.com",
        uid: "google-drive/default",
        data: {},
      }),
      VERIFY_TARGETS.microsoft.oauth,
    );
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

  it("includes Attio's native OAuth and API-key targets", () => {
    assert.equal(
      VERIFY_TARGETS.attio.oauth.url,
      "https://api.attio.com/v2/objects",
    );
    assert.equal(
      VERIFY_TARGETS.attio.apiKey.url,
      "https://api.attio.com/v2/objects",
    );
    assert.deepEqual(VERIFY_TARGETS.attio.apiKey.requiredFields, ["data"]);
    assert.deepEqual(VERIFY_TARGETS.attio.oauth.requiredFields, ["data"]);
  });

  it("rejects wrong-shaped Attio replies for either credential method", async () => {
    for (const target of [
      VERIFY_TARGETS.attio.oauth,
      VERIFY_TARGETS.attio.apiKey,
    ]) {
      const result = await verifyWithToken(target, TOKEN, async () =>
        Response.json({ items: [] }),
      );
      assert.equal(result.ok, false);
    }
  });

  it("requires Origin's actual rate-limit resource fields", async () => {
    assert.deepEqual(VERIFY_TARGETS.origin.oauth.requiredFields, [
      "resources.core.limit",
      "resources.core.remaining",
      "resources.core.reset",
      "resources.core.used",
    ]);
    const result = await verifyWithToken(
      VERIFY_TARGETS.origin.oauth,
      TOKEN,
      async () => Response.json({}),
    );
    assert.equal(result.ok, false);
  });

  it("omits targets whose local endpoint parameters cannot be recovered safely", () => {
    assert.equal(VERIFY_TARGETS.obsidian, undefined);
  });
});
