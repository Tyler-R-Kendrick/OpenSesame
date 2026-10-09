import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { verifyTargets } from "../../scripts/emit-connect-verify-targets.mjs";
import { VERIFY_TARGETS } from "../connect-verify-targets.generated.mjs";
import {
  resolveTarget,
  verifyTargetFor,
  verifyWithToken,
} from "../connect-verify.mjs";

const presets = JSON.parse(
  readFileSync(
    new URL(
      "../../../../spec/connectors/connect-presets.json",
      import.meta.url,
    ),
  ),
);
const TOKEN = "synthetic-legacy-provider-token";

function source(service) {
  const row = presets.api_key.find((item) => item.service === service);
  assert.ok(row);
  return row;
}

function pinned(service) {
  const connector = { service, type: "api-key", data: {} };
  return resolveTarget(verifyTargetFor(connector), connector);
}

describe("existing single-key relay contracts", () => {
  it("keeps Anthropic verification usable without an optional workspace", async () => {
    const target = pinned("anthropic");
    assert.deepEqual(target.headers, {
      "anthropic-version": "2023-06-01",
      "anthropic-dangerous-direct-browser-access": "true",
    });
    let calls = 0;
    const result = await verifyWithToken(target, TOKEN, async (url, init) => {
      calls += 1;
      assert.equal(url, "https://api.anthropic.com/v1/models");
      assert.equal(init.headers.get("x-api-key"), TOKEN);
      assert.equal(
        init.headers.get("anthropic-dangerous-direct-browser-access"),
        "true",
      );
      assert.equal(init.headers.has("anthropic-workspace-id"), false);
      return Response.json({ data: [] });
    });
    assert.equal(calls, 1);
    assert.equal(result.ok, true);
  });

  for (const service of ["assemblyai", "honeycomb", "mailgun", "typeform"]) {
    it(`verifies ${service} at its documented default region`, async () => {
      const row = source(service);
      const choices = row.template_params.find(
        (item) => item.name === "api_host",
      ).choices;
      const target = pinned(service);
      assert.equal(new URL(target.url).hostname, choices[0].value);
      assert.ok(
        row.service_urls.some(
          (url) => new URL(url).hostname === choices[0].value,
        ),
      );
      assert.equal(target.url.includes("{"), false);
      let calls = 0;
      const result = await verifyWithToken(target, TOKEN, async (url) => {
        calls += 1;
        assert.equal(url, target.url);
        return Response.json(
          service === "honeycomb"
            ? { team: { name: "Team", slug: "team" }, api_key_access: "events" }
            : { ok: true },
        );
      });
      assert.equal(calls, 1);
      assert.equal(result.ok, true);
    });
  }

  it("preserves Datadog's API-key-only validation without claiming an account or application-key proof", async () => {
    const row = source("datadog");
    assert.equal(row.verify.url, "https://api.{site}/api/v2/validate_keys");
    assert.equal(row.verify.headers["DD-APPLICATION-KEY"], "{application_key}");
    assert.equal(row.legacy_verify.url, "https://api.{site}/api/v1/validate");
    const target = pinned("datadog");
    assert.equal(target.url, "https://api.datadoghq.com/api/v1/validate");
    assert.equal(target.accountField, null);
    const result = await verifyWithToken(target, TOKEN, async (url, init) => {
      assert.equal(url, target.url);
      assert.equal(init.headers.get("DD-API-KEY"), TOKEN);
      assert.equal(init.headers.has("DD-APPLICATION-KEY"), false);
      return Response.json({ valid: true });
    });
    assert.deepEqual(result, { status: 200, ok: true, account: "" });
  });
});

describe("legacy proof refuses unsupported credential metadata", () => {
  it("makes no provider call for unsupported additional-secret or compound-header contracts", async () => {
    for (const service of ["marqeta", "pagerduty"]) {
      assert.equal(VERIFY_TARGETS[service]?.apiKey, undefined);
      assert.equal(
        await verifyWithToken(pinned(service), TOKEN, () =>
          assert.fail("must not fetch"),
        ),
        null,
      );
    }
  });

  it("uses only declared public choices and leaves unknown or secret parameters unresolved", () => {
    const row = source("assemblyai");
    const publicTarget = verifyTargets(
      { services: [] },
      {
        oauth: [],
        api_key: [row],
      },
    ).assemblyai.apiKey;
    assert.equal(
      publicTarget.url,
      "https://api.assemblyai.com/v2/transcript?limit=1",
    );
    const secretTarget = verifyTargets(
      { services: [] },
      {
        oauth: [],
        api_key: [
          {
            ...row,
            template_params: [{ ...row.template_params[0], secret: true }],
          },
        ],
      },
    ).assemblyai.apiKey;
    assert.equal(secretTarget.url, row.verify.url);
    const unknownTarget = verifyTargets(
      { services: [] },
      {
        oauth: [],
        api_key: [{ ...row, template_params: [] }],
      },
    ).assemblyai.apiKey;
    assert.equal(unknownTarget.url, row.verify.url);
  });
});
