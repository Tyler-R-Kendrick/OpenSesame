import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  allowsHeaders,
  endpointsOf,
  hostOf,
  isDirect,
  isTemplate,
  moved,
  needsPreflight,
  observe,
  preflightNeeds,
  requestFor,
} from "./oauth-reach-probes.mjs";

const ORIGIN = "https://tyler-r-kendrick.github.io";
const root = join(dirname(fileURLToPath(import.meta.url)), "../..");
const spec = (name) =>
  JSON.parse(readFileSync(join(root, "spec/connectors", name), "utf8"));

const preset = {
  token_endpoint: "https://api.example.com/oauth/token",
  token_endpoint_auth_method: "client_secret_basic",
  userinfo_endpoint: null,
  revocation_endpoint: "https://api.example.com/oauth/revoke",
  verify: { method: "GET", url: "https://api.example.com/me" },
};

describe("endpointsOf", () => {
  it("asks about the token, account and revocation endpoints, and how each is called", () => {
    expect(endpointsOf(preset)).toEqual([
      {
        stage: "token",
        url: preset.token_endpoint,
        method: "POST",
        auth: "basic",
      },
      {
        stage: "resource",
        url: "https://api.example.com/me",
        method: "GET",
        auth: "bearer",
      },
      {
        stage: "revocation",
        url: preset.revocation_endpoint,
        method: "POST",
        auth: "basic",
      },
    ]);
  });

  it("falls back to the userinfo endpoint and skips what a provider does not have", () => {
    const found = endpointsOf({
      ...preset,
      token_endpoint_auth_method: "client_secret_post",
      verify: null,
      userinfo_endpoint: "https://api.example.com/userinfo",
      revocation_endpoint: null,
    });
    expect(found.map((item) => item.stage)).toEqual(["token", "resource"]);
    expect(found[0].auth).toBe("post");
    expect(found[1].url).toBe("https://api.example.com/userinfo");
  });
});

describe("requestFor", () => {
  it("sends fake credentials only, in the shape the real call has", () => {
    const [token, resource] = endpointsOf(preset);
    const asked = requestFor(token, ORIGIN);
    expect(asked.headers.authorization).toBe("Basic cHJvYmU6cHJvYmU=");
    expect(asked.body).toContain("code=probe");
    expect(asked.body).not.toContain("client_secret");
    expect(requestFor(resource, ORIGIN).headers.authorization).toBe(
      "Bearer probe",
    );
    const post = endpointsOf({
      ...preset,
      token_endpoint_auth_method: "client_secret_post",
    })[0];
    expect(requestFor(post, ORIGIN).body).toContain("client_secret=probe");
  });
});

describe("whether a page can read an endpoint", () => {
  it("needs a preflight only for a custom header", () => {
    const [token, resource] = endpointsOf(preset);
    expect(needsPreflight(token)).toBe(true);
    expect(preflightNeeds(token)).toEqual(["authorization"]);
    expect(needsPreflight(resource)).toBe(true);
    const post = endpointsOf({
      ...preset,
      token_endpoint_auth_method: "client_secret_post",
    })[0];
    expect(needsPreflight(post)).toBe(false);
  });

  it("does not let `*` stand for Authorization, which has to be named", () => {
    expect(allowsHeaders("*", ["authorization"])).toBe(false);
    expect(
      allowsHeaders("content-type, Authorization", ["authorization"]),
    ).toBe(true);
    expect(allowsHeaders(null, ["authorization"])).toBe(false);
    expect(allowsHeaders(null, [])).toBe(true);
  });

  it("is direct when the real answer admits the origin and the preflight names the headers", () => {
    const [token] = endpointsOf(preset);
    const answer = observe(400, { "access-control-allow-origin": "*" });
    const named = observe(204, {
      "access-control-allow-origin": ORIGIN,
      "access-control-allow-headers": "authorization,content-type",
    });
    const wildcard = observe(204, {
      "access-control-allow-origin": "*",
      "access-control-allow-headers": "*",
    });
    expect(isDirect(token, answer, named, ORIGIN)).toBe(true);
    expect(isDirect(token, answer, wildcard, ORIGIN)).toBe(false);
    expect(isDirect(token, answer, null, ORIGIN)).toBe(false);
    expect(isDirect(token, observe(400, {}), named, ORIGIN)).toBe(false);
    expect(
      isDirect(
        token,
        answer,
        observe(204, {
          "access-control-allow-origin": "https://other.example",
        }),
        ORIGIN,
      ),
    ).toBe(false);
  });

  it("is direct for a form post with no custom header on the real answer alone", () => {
    const post = endpointsOf({
      ...preset,
      token_endpoint_auth_method: "client_secret_post",
    })[0];
    expect(
      isDirect(
        post,
        observe(400, { "access-control-allow-origin": "*" }),
        null,
        ORIGIN,
      ),
    ).toBe(true);
    expect(isDirect(post, observe(400, {}), null, ORIGIN)).toBe(false);
  });
});

describe("addresses and drift", () => {
  it("knows a tenant address from a literal one", () => {
    expect(isTemplate("https://{domain}/oauth/token")).toBe(true);
    expect(hostOf("https://{domain}/oauth/token")).toBeNull();
    expect(hostOf("https://zoom.us/oauth/token")).toBe("zoom.us");
  });

  it("reports a verdict that moved, and nothing when it did not", () => {
    expect(moved({ direct: true }, false)).toBe("was direct, now refused");
    expect(moved({ direct: false }, true)).toBe("was refused, now direct");
    expect(moved({ direct: true }, true)).toBeNull();
  });
});

describe("the recorded evidence", () => {
  const recorded = spec("oauth-reach.json");
  const presets = spec("connect-presets.json").oauth;

  it("covers every confidential OAuth preset with its own route, once", () => {
    const ids = recorded.providers.map((row) => row.provider_id);
    expect(new Set(ids).size).toBe(ids.length);
    const expected = presets
      .filter((row) => row.token_endpoint_auth_method !== "none")
      .map((row) => row.service)
      .filter((id) => !["github", "linear", "bitbucket"].includes(id));
    expect(ids.sort()).toEqual(expected.sort());
  });

  it("records a probe for every endpoint it did not leave to a tenant", () => {
    for (const row of recorded.providers)
      for (const endpoint of row.endpoints)
        if (endpoint.tenant) expect(endpoint.direct).toBe(false);
        else {
          expect(endpoint.probe.checked_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
          expect([true, false]).toContain(endpoint.direct);
        }
  });

  it("names a tenant family only under a registrable domain, for a provider with a tenant endpoint", () => {
    for (const row of recorded.providers) {
      const hasTenant = row.endpoints.some((endpoint) => endpoint.tenant);
      expect(!!row.tenant_hosts).toBe(hasTenant);
      for (const family of row.tenant_hosts ?? [])
        expect(family).toMatch(/^\*\.[a-z0-9-]+(\.[a-z0-9-]+)+$/);
    }
  });
});
