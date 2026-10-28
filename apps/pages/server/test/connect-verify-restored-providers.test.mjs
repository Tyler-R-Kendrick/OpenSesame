import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { relayVerificationPresets } from "../../scripts/emit-connect-verify-targets.mjs";
import { VERIFY_TARGETS } from "../connect-verify-targets.generated.mjs";
import { verifyTargetFor, verifyWithToken } from "../connect-verify.mjs";

const TOKEN = "synthetic-legacy-provider-token";

describe("preserved relay verification contracts", () => {
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
      null,
    );
  });

  it("rejects wrong-shaped Attio replies for either credential method", async () => {
    for (const target of [
      VERIFY_TARGETS.attio.oauth,
      VERIFY_TARGETS.attio.apiKey,
    ]) {
      assert.equal(target.url, "https://api.attio.com/v2/objects");
      assert.deepEqual(target.requiredFields, ["data"]);
      const result = await verifyWithToken(target, TOKEN, async () =>
        Response.json({ items: [] }),
      );
      assert.equal(result.ok, false);
    }
  });

  it("requires Origin's actual rate-limit resource fields", async () => {
    const target = VERIFY_TARGETS.origin.oauth;
    for (const service of ["cursor.com", "api.cursor.com"]) {
      assert.equal(
        verifyTargetFor({ service, uid: "origin/default", data: {} }),
        target,
      );
    }
    assert.deepEqual(target.requiredFields, [
      "resources.core.limit",
      "resources.core.remaining",
      "resources.core.reset",
      "resources.core.used",
    ]);
    const result = await verifyWithToken(target, TOKEN, async () =>
      Response.json({}),
    );
    assert.equal(result.ok, false);
  });

  it("refuses fal when the relay cannot recover its request ID", async () => {
    assert.equal(VERIFY_TARGETS["fal-ai"], undefined);
    const target = verifyTargetFor({
      service: "fal-ai",
      type: "api-key",
      data: {},
    });
    assert.equal(target, null);
    assert.equal(
      await verifyWithToken(target, TOKEN, () => assert.fail("must not fetch")),
      null,
    );
  });

  it("refuses Obsidian when the relay cannot recover its local host and port", async () => {
    assert.equal(VERIFY_TARGETS.obsidian, undefined);
    const target = verifyTargetFor({
      service: "obsidian",
      type: "api-key",
      data: {},
    });
    assert.equal(target, null);
    assert.equal(
      await verifyWithToken(target, TOKEN, () => assert.fail("must not fetch")),
      null,
    );
  });
});

describe("relay-only source ownership", () => {
  const shared = { oauth: [], api_key: [] };
  const relay = {
    schema_version: 1,
    oauth: [{ service: "google-drive" }],
    api_key: [{ service: "obsidian" }],
  };

  it("does not modify the shared connector presets", () => {
    const merged = relayVerificationPresets(shared, relay);
    assert.deepEqual(shared, { oauth: [], api_key: [] });
    assert.deepEqual(merged.oauth, relay.oauth);
    assert.deepEqual(merged.api_key, relay.api_key);
  });

  it("rejects duplicate shared, relay or cross-source provider methods", () => {
    for (const [primary, supplemental] of [
      [{ oauth: [{ service: "x" }, { service: "x" }], api_key: [] }, relay],
      [shared, { ...relay, oauth: [{ service: "x" }, { service: "x" }] }],
      [{ oauth: [{ service: "google-drive" }], api_key: [] }, relay],
      [{ oauth: [], api_key: [{ service: "obsidian" }] }, relay],
    ])
      assert.throws(() => relayVerificationPresets(primary, supplemental));
  });

  it("rejects invalid schema and unsafe service identifiers", () => {
    for (const supplemental of [
      null,
      { ...relay, schema_version: 2 },
      { ...relay, oauth: [{ service: "constructor" }] },
      { ...relay, oauth: [{ service: "__proto__" }] },
      {
        ...relay,
        oauth: [
          {
            service: "origin",
            legacy_server_urls: ["https://user@example.com"],
          },
        ],
      },
    ])
      assert.throws(() => relayVerificationPresets(shared, supplemental));
  });
});
