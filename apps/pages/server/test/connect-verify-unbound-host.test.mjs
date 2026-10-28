import assert from "node:assert/strict";
import { test } from "node:test";
import { VERIFY_TARGETS } from "../connect-verify-targets.generated.mjs";
import {
  resolveTarget,
  verifyTargetFor,
  verifyWithToken,
} from "../connect-verify.mjs";

const token = "synthetic-test-token";
const unbound = [
  ["auth0", "oauth"],
  ["databricks", "oauth"],
  ["obsidian", "apiKey"],
  ["okta", "oauth"],
  ["shopify", "oauth"],
  ["workday", "oauth"],
];
for (const [service, kind] of unbound) {
  for (const host of ["attacker.example", "127.0.0.1"]) {
    test(`${service} rejects an unbound ${host} credential destination`, async () => {
      const target =
        VERIFY_TARGETS[service]?.[kind] ??
        (service === "obsidian"
          ? {
              kind: "api-key",
              method: "GET",
              url: "https://{obsidian_endpoint}/",
              header: "Authorization",
              scheme: "Bearer",
              sources: [
                {
                  template: "https://{obsidian_endpoint}",
                  field: "serviceUrls.0",
                },
              ],
            }
          : undefined);
      assert.ok(target);
      const connector = {
        service,
        type: kind === "apiKey" ? "api-key" : "oauth",
        data: { serverConfig: {}, serviceUrls: [] },
      };
      for (const source of target.sources) {
        const value = source.template.replace(/\{([a-z_]+)\}/g, (_, key) =>
          key === "tenant" ? "tenant" : host,
        );
        const [parent, key] = source.field.split(".");
        connector.data[parent][key] = value;
      }
      if (VERIFY_TARGETS[service])
        assert.equal(verifyTargetFor(connector), target);
      const resolved = resolveTarget(target, connector);
      assert.ok(!resolved.url.includes("{"));
      assert.equal(
        await verifyWithToken(resolved, token, () =>
          assert.fail("must not fetch"),
        ),
        null,
      );
    });
  }
}
test("a fixed provider suffix retains its resolved proof", async () => {
  const target = VERIFY_TARGETS.bamboohr.apiKey;
  const connector = {
    data: {
      serviceUrls: [
        "https://tenant.bamboohr.com/api/v1",
        "https://api.bamboohr.com/api/gateway.php/tenant/v1",
      ],
    },
  };
  const resolved = resolveTarget(target, connector);
  assert.equal(resolved.url, "https://tenant.bamboohr.com/api/v1/meta/fields");
  let calls = 0;
  const result = await verifyWithToken(resolved, token, async () => {
    calls++;
    return Response.json({ fields: [] });
  });
  assert.equal(calls, 1);
  assert.equal(result.ok, true);
});
test("a multi-placeholder-only authority and dynamic port remain unbound", async () => {
  const target = {
    kind: "api-key",
    method: "GET",
    url: "https://attacker.example:443/",
    header: "Authorization",
    scheme: "Bearer",
    sources: [{ template: "https://{tenant}.{domain}:{port}/" }],
  };
  assert.equal(
    await verifyWithToken(target, token, () => assert.fail("must not fetch")),
    null,
  );
});
test("generated unsafe classification survives mutation of a resolved target source", async () => {
  const target = VERIFY_TARGETS.auth0.oauth;
  const connector = {
    data: {
      serverConfig: {
        authorization_endpoint: "https://attacker.example/authorize",
        token_endpoint: "https://attacker.example/oauth/token",
      },
    },
  };
  const resolved = resolveTarget(target, connector);
  assert.equal(resolved.url, "https://attacker.example/userinfo");
  resolved.sources = [];
  assert.equal(
    await verifyWithToken(resolved, token, () => assert.fail("must not fetch")),
    null,
  );
});
for (const template of ["https://api.{domain}/me", "https://{tenant}.com/me"]) {
  test(`a future unreviewed ${template} template stays closed`, async () => {
    const target = {
      kind: "oauth",
      method: "GET",
      url: template,
      header: "Authorization",
      scheme: "Bearer",
      sources: [{ field: "serverConfig.token_endpoint", template }],
    };
    const connector = {
      data: {
        serverConfig: {
          token_endpoint: template.replace(/\{[a-z_]+\}/g, "attacker"),
        },
      },
    };
    const resolved = resolveTarget(target, connector);
    assert.ok(!resolved.url.includes("{"));
    assert.equal(
      await verifyWithToken(resolved, token, () =>
        assert.fail("must not fetch"),
      ),
      null,
    );
  });
}
for (const [service, urls] of [
  ["algolia", ["https://tenant.algolia.net", "https://tenant-dsn.algolia.net"]],
  ["n8n", ["https://tenant.app.n8n.cloud/api/v1"]],
  ["sanity", ["https://tenant.api.sanity.io"]],
]) {
  test(`${service} keeps its existing provider-bound target`, async () => {
    const target = VERIFY_TARGETS[service].apiKey;
    const resolved = resolveTarget(target, { data: { serviceUrls: urls } });
    assert.ok(!resolved.url.includes("{"));
    let calls = 0;
    const result = await verifyWithToken(resolved, token, async () => {
      calls++;
      return Response.json({ value: "ok", id: "synthetic-account" });
    });
    assert.equal(calls, 1);
    assert.equal(result.ok, true);
  });
}
test("an invalid or insecure verification origin is refused", async () => {
  for (const url of [
    "http://provider.example/me",
    "https://user:pass@provider.example/me",
  ]) {
    const target = {
      kind: "oauth",
      method: "GET",
      url,
      header: "Authorization",
      scheme: "Bearer",
    };
    assert.equal(
      await verifyWithToken(target, token, () => assert.fail("must not fetch")),
      null,
    );
  }
});

test("a cloned resolved target with unbound source metadata stays closed", async () => {
  const target = {
    ...VERIFY_TARGETS.auth0.oauth,
    url: "https://attacker.example/userinfo",
  };
  const resolved = resolveTarget(target, { data: {} });
  assert.equal(
    await verifyWithToken(resolved, token, () => assert.fail("must not fetch")),
    null,
  );
});

test("a provider redirect is refused without forwarding a token", async () => {
  const target = VERIFY_TARGETS.bamboohr.apiKey;
  const connector = {
    data: {
      serviceUrls: [
        "https://tenant.bamboohr.com/api/v1",
        "https://api.bamboohr.com/api/gateway.php/tenant/v1",
      ],
    },
  };
  const resolved = resolveTarget(target, connector);
  let calls = 0;
  const result = await verifyWithToken(resolved, token, async (url, init) => {
    calls++;
    assert.equal(url, "https://tenant.bamboohr.com/api/v1/meta/fields");
    assert.equal(init.redirect, "manual");
    assert.equal(init.headers.has("Authorization"), true);
    return new Response(null, {
      status: 302,
      headers: { location: "https://attacker.example/token-collector" },
    });
  });
  assert.deepEqual(result, { status: 302, ok: false, account: "" });
  assert.equal(calls, 1);
});
