import type { BoundaryValue } from "@opensesame/os-domain";
/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { identitySeams } from "./identity.js";
import {
  brokeredOrgUpstream,
  brokeredRealmUpstream,
  brokeredUpstream,
  listFederatedProviders,
  requestEmailMagicLink,
  workEmailDomain,
} from "./providers.js";

const originalIdentityBase = identitySeams.identityBase;
const BASE = "http://127.0.0.1:18788";

function jsonOnce(body: BoundaryValue, status = 200): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(() =>
    Promise.resolve(
      new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      }),
    ),
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

beforeEach(() => {
  identitySeams.identityBase = () => BASE;
});

afterEach(() => {
  identitySeams.identityBase = originalIdentityBase;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("listFederatedProviders", () => {
  it("returns the catalog the Identity API publishes", async () => {
    const fetchMock = jsonOnce({
      providers: [
        { id: "shoo", label: "Google", kind: "oidc", browserCapable: true },
        {
          id: "github",
          label: "GitHub",
          kind: "oauth2",
          browserCapable: false,
        },
      ],
    });
    await expect(listFederatedProviders()).resolves.toEqual([
      { id: "shoo", label: "Google", kind: "oidc", browserCapable: true },
      { id: "github", label: "GitHub", kind: "oauth2", browserCapable: false },
    ]);
    expect(fetchMock.mock.calls[0]?.[0]).toBe(`${BASE}/v1/federated/providers`);
  });

  it("drops rows that are not the published contract", async () => {
    jsonOnce({
      providers: [
        { id: "shoo", label: "Google", kind: "oidc", browserCapable: true },
        { id: "", label: "Nameless", kind: "oidc", browserCapable: true },
        { id: "weird", label: "Weird", kind: "saml", browserCapable: true },
        { id: "half", label: "Half" },
        "not-an-object",
      ],
    });
    await expect(listFederatedProviders()).resolves.toEqual([
      { id: "shoo", label: "Google", kind: "oidc", browserCapable: true },
    ]);
  });

  it("falls back to an empty catalog when the endpoint is missing", async () => {
    jsonOnce({ error: "not_found" }, 404);
    await expect(listFederatedProviders()).resolves.toEqual([]);
  });

  it("falls back to an empty catalog when the Identity API is unreachable", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.reject(new TypeError("Failed to fetch"))),
    );
    await expect(listFederatedProviders()).resolves.toEqual([]);
  });

  it("falls back to an empty catalog when the body is not the contract", async () => {
    jsonOnce({ providers: "everything" });
    await expect(listFederatedProviders()).resolves.toEqual([]);
  });

  it("asks nobody when no Identity API is configured", async () => {
    identitySeams.identityBase = () => "";
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await expect(listFederatedProviders()).resolves.toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("brokered upstreams", () => {
  it("points a brokered provider at the Identity API, not the provider", () => {
    expect(
      brokeredUpstream({
        id: "google",
        label: "Google",
        kind: "oidc",
        browserCapable: false,
      }),
    ).toEqual({
      id: "broker:google",
      issuer: BASE,
      displayName: "Google",
      accountKind: "Google",
    });
  });

  it("brokers an organization and a home-realm lookup through the same issuer", () => {
    expect(
      brokeredOrgUpstream({ slug: "acme", displayName: "Acme" }),
    ).toMatchObject({ id: "broker:org:acme", issuer: BASE });
    expect(brokeredRealmUpstream()).toMatchObject({
      id: "broker:realm",
      issuer: BASE,
    });
  });
});

describe("workEmailDomain", () => {
  it("keeps the domain and discards the local part", () => {
    expect(workEmailDomain("Ada.Lovelace+tag@Acme.Example")).toBe(
      "acme.example",
    );
    expect(workEmailDomain("weird@name@acme.co.uk")).toBe("acme.co.uk");
  });

  it("answers empty for anything that is not an address", () => {
    for (const bad of ["", "acme.com", "@acme.com", "you@", "you@localhost"]) {
      expect(workEmailDomain(bad), bad).toBe("");
    }
  });
});

describe("requestEmailMagicLink", () => {
  it("posts the address to the Identity API's magic-link route", async () => {
    const fetchMock = jsonOnce({ status: true });
    await requestEmailMagicLink("ada@example.com");
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe(`${BASE}/v1/auth/sign-in/magic-link`);
    expect(JSON.parse(String(init?.body))).toMatchObject({
      email: "ada@example.com",
    });
    // The token IS the credential on the way back; no cookie rides along.
    expect(init?.credentials).toBe("omit");
  });

  it("says so plainly when the deployment has no email sign-in", async () => {
    jsonOnce({ error: "not_found" }, 404);
    await expect(requestEmailMagicLink("ada@example.com")).rejects.toThrow(
      /not available/,
    );
  });

  it("refuses to send when no Identity API is configured", async () => {
    identitySeams.identityBase = () => "";
    await expect(requestEmailMagicLink("ada@example.com")).rejects.toThrow(
      /No Identity API/,
    );
  });
});
