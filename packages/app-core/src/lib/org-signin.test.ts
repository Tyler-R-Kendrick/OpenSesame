/**
 * Organization sign-in settings as a model, ported from
 * `apps/console/src/pages/OrgSignInPage.test.tsx`.
 */
import type { BoundaryValue } from "@opensesame/os-domain";
import { afterEach, describe, expect, it, vi } from "vitest";
import { deviceIdentitySeams } from "./device-identity.js";
import { identitySeams } from "./identity.js";
import {
  OrgSignInError,
  type OrgSignInOrganization,
  type OrgSignInTransport,
  orgSignInClient,
  orgSignInOffered,
  upstreamPatch,
} from "./org-signin.js";

type Reply = { status?: number; body?: BoundaryValue };

const OWNER_ORG = {
  id: "org_1",
  slug: "acme",
  displayName: "Acme",
  role: "owner",
  ssoIssuer: "https://idp.acme.example",
  ssoClientSecretConfigured: true,
};

/** Answer by method and path, the latest reply winning, like the console's. */
function fake(routes: Record<string, Reply>) {
  const seen: Array<{ method: string; path: string; body?: string }> = [];
  const fetch = vi.fn(async (path: string, init: RequestInit) => {
    const method = init.method ?? "GET";
    seen.push({
      method,
      path,
      ...(init.body ? { body: String(init.body) } : {}),
    });
    const next = routes[`${method} ${path}`];
    if (!next)
      return new Response(JSON.stringify({ error: "not_found" }), {
        status: 404,
      });
    const status = next.status ?? 200;
    if (status === 204) return new Response(null, { status });
    return new Response(JSON.stringify(next.body ?? {}), { status });
  });
  const transport: OrgSignInTransport = {
    fetch,
    base: () => "https://id.example/",
  };
  return { seen, fetch, client: orgSignInClient(transport) };
}

async function ownerOrg(routes: Record<string, Reply> = {}) {
  const f = fake({
    "GET /v1/organizations": { body: { organizations: [OWNER_ORG] } },
    ...routes,
  });
  const [org] = await f.client.listOrganizations();
  if (!org) throw new Error("expected an organization");
  return { ...f, org };
}

const original = { ...identitySeams };
afterEach(() => {
  Object.assign(identitySeams, original);
});

describe("organizations", () => {
  it("reads no organizations as none", async () => {
    const { client } = fake({
      "GET /v1/organizations": { body: { organizations: [] } },
    });
    expect(await client.listOrganizations()).toEqual([]);
  });

  it("refuses a member who is not an owner, before any call", async () => {
    const { client, fetch } = fake({
      "GET /v1/organizations": {
        body: { organizations: [{ ...OWNER_ORG, role: "member" }] },
      },
    });
    const [org] = await client.listOrganizations();
    if (!org) throw new Error("expected an organization");
    expect(org.owner).toBe(false);

    await expect(client.listDomains(org)).rejects.toThrow(/Only an owner/);
    await expect(client.mintToken(org)).rejects.toThrow(/Only an owner/);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("never seeds the secret, only whether one is stored", async () => {
    const { org } = await ownerOrg();
    expect(org.secretStored).toBe(true);
    expect(org.upstream.ssoClientSecret).toBe("");
    expect(org.upstream.ssoIssuer).toBe("https://idp.acme.example");
  });
});

describe("upstream", () => {
  it("saves the organization's upstream configuration", async () => {
    const { client, org, seen } = await ownerOrg({
      "PATCH /v1/organizations/org_1": { body: { id: "org_1" } },
    });
    const words = await client.saveUpstream(org, {
      ...org.upstream,
      samlMetadataUrl: "https://idp.acme.example/saml/metadata",
    });

    expect(words).toBe("Organization sign-in saved.");
    const patch = seen.find((call) => call.method === "PATCH");
    expect(JSON.parse(String(patch?.body))).toEqual({
      ssoIssuer: "https://idp.acme.example",
      ssoClientId: null,
      samlIssuer: null,
      samlMetadataUrl: "https://idp.acme.example/saml/metadata",
    });
  });

  it("saves the client credentials a tenant registered at their IdP", () => {
    const form = {
      ssoIssuer: "https://idp.acme.example",
      ssoClientId: " acme-client-id ",
      ssoClientSecret: "acme-client-secret",
      samlIssuer: "",
      samlMetadataUrl: "",
    };
    expect(upstreamPatch(form)).toMatchObject({
      ssoClientId: "acme-client-id",
      ssoClientSecret: "acme-client-secret",
    });
  });

  it("leaves a stored secret alone when the box is left empty", () => {
    const patch = upstreamPatch({
      ssoIssuer: "https://idp.acme.example",
      ssoClientId: "acme-client-id",
      ssoClientSecret: "   ",
      samlIssuer: "",
      samlMetadataUrl: "",
    });
    expect(patch).not.toHaveProperty("ssoClientSecret");
  });

  it("gives the one redirect URI a provider must be given", async () => {
    const { client } = await ownerOrg();
    expect(client.redirectUri()).toBe(
      "https://id.example/v1/federated/callback",
    );
    expect(client.redirectUri()).not.toContain("/interaction/");
  });

  it("shows the server's reason for an issuer it will not call", async () => {
    const { client, org } = await ownerOrg({
      "PATCH /v1/organizations/org_1": {
        status: 400,
        body: {
          error: "unsafe_issuer",
          message: "An organization cannot claim this deployment's own issuer.",
        },
      },
    });
    await expect(client.saveUpstream(org, org.upstream)).rejects.toThrow(
      "An organization cannot claim this deployment's own issuer.",
    );
  });
});

describe("email domains", () => {
  const CLAIMED = {
    domain: "acme.example",
    txtRecord: "opensesame-domain-verify=tok_1",
    verifiedAt: null,
  };

  it("gives the TXT record to publish, then verifies the domain", async () => {
    const { client, org } = await ownerOrg({
      "POST /v1/organizations/org_1/domains": { status: 201, body: CLAIMED },
      "POST /v1/organizations/org_1/domains/acme.example/verify": {
        body: { ...CLAIMED, verifiedAt: "2026-08-25T00:00:00.000Z" },
      },
    });

    const claimed = await client.claimDomain(org, " acme.example ");
    expect(claimed.row.txtRecord).toBe("opensesame-domain-verify=tok_1");
    expect(claimed.words).toBe(
      "Publish the TXT record for acme.example, then verify it.",
    );
    const verified = await client.verifyDomain(org, "acme.example");
    expect(verified.words).toBe("acme.example is verified.");
    expect(verified.row.verifiedAt).not.toBeNull();
  });

  it("surfaces a domain another organization already holds", async () => {
    const { client, org } = await ownerOrg({
      "POST /v1/organizations/org_1/domains": {
        status: 409,
        body: { error: "domain_taken", message: "irrelevant" },
      },
    });
    const refused = await client
      .claimDomain(org, "acme.example")
      .catch((e) => e);
    expect(refused).toBeInstanceOf(OrgSignInError);
    expect(refused.message).toContain(
      "already claimed by another organization",
    );
  });

  it("asks for a domain before claiming nothing", async () => {
    const { client, org, fetch } = await ownerOrg();
    await expect(client.claimDomain(org, "  ")).rejects.toThrow(
      /Type the domain/,
    );
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("releases a domain", async () => {
    const { client, org } = await ownerOrg({
      "DELETE /v1/organizations/org_1/domains/acme.example": { status: 204 },
    });
    expect(await client.releaseDomain(org, "acme.example")).toBe(
      "acme.example released.",
    );
  });
});

describe("provisioning tokens", () => {
  it("hands a minted token over once and keeps it nowhere", async () => {
    const { client, org, seen } = await ownerOrg({
      "POST /v1/organizations/org_1/scim/tokens": {
        status: 201,
        body: { id: "sct_id_1", token: "sct_plaintext_value" },
      },
      "GET /v1/organizations/org_1/scim/tokens": {
        body: {
          tokens: [
            {
              id: "sct_id_1",
              createdAt: "2026-08-25T00:00:00.000Z",
              revokedAt: null,
            },
          ],
        },
      },
    });

    const minted = await client.mintToken(org);
    expect(minted).toEqual({ id: "sct_id_1", token: "sct_plaintext_value" });

    // Nothing brings it back: the list carries ids and dates only.
    const tokens = await client.listTokens(org);
    expect(tokens).toEqual([
      { id: "sct_id_1", createdAt: "2026-08-25T00:00:00.000Z", revoked: false },
    ]);
    expect(JSON.stringify(tokens)).not.toContain("sct_plaintext_value");
    expect(JSON.stringify(seen)).not.toContain("sct_plaintext_value");
  });

  it("revokes a provisioning token", async () => {
    const { client, org } = await ownerOrg({
      "DELETE /v1/organizations/org_1/scim/tokens/sct_id_1": { status: 204 },
    });
    expect(await client.revokeToken(org, "sct_id_1")).toBe(
      "Provisioning token revoked.",
    );
  });

  it("hands over the SCIM base address the Identity API names", async () => {
    const { client, org } = await ownerOrg({
      "POST /v1/organizations/org_1/scim/tokens": {
        status: 201,
        body: {
          id: "sct_id_1",
          token: "sct_plaintext_value",
          scimBaseUrl: "https://id.example/v1/organizations/org_1/scim/v2",
        },
      },
    });
    expect(await client.mintToken(org)).toEqual({
      id: "sct_id_1",
      token: "sct_plaintext_value",
      scimBaseUrl: "https://id.example/v1/organizations/org_1/scim/v2",
    });
  });

  it("refuses an answer with no plaintext rather than inventing one", async () => {
    const { client, org } = await ownerOrg({
      "POST /v1/organizations/org_1/scim/tokens": {
        status: 201,
        body: { id: "x" },
      },
    });
    await expect(client.mintToken(org)).rejects.toThrow(/cannot read/);
  });
});

describe("orgSignInOffered", () => {
  const originalDevice = { ...deviceIdentitySeams };
  afterEach(() => {
    Object.assign(deviceIdentitySeams, originalDevice);
  });
  const SESSION = {
    principalId: "prn_1",
    accessToken: "at",
    issuerOrigin: "https://id.example",
  };

  it("is offered only with an Identity API and a session", () => {
    deviceIdentitySeams.remoteIdentityApi = () => "";
    identitySeams.currentSession = () => SESSION;
    expect(orgSignInOffered()).toBe(false);

    deviceIdentitySeams.remoteIdentityApi = () => "https://id.example";
    identitySeams.currentSession = () => null;
    expect(orgSignInOffered()).toBe(false);

    identitySeams.currentSession = () => SESSION;
    expect(orgSignInOffered()).toBe(true);
  });

  it("is not offered through a transport that cannot say who is signed in", () => {
    deviceIdentitySeams.remoteIdentityApi = () => "https://id.example";
    expect(
      orgSignInOffered({ fetch: vi.fn(), base: () => "https://id.example" }),
    ).toBe(false);
  });
});

describe("the Identity transport", () => {
  it("rides identityFetch at base-relative paths", async () => {
    const identityFetch = vi.fn(
      async () => new Response(JSON.stringify({ organizations: [] })),
    );
    identitySeams.identityFetch = identityFetch;
    identitySeams.identityBase = () => "https://id.example";

    const client = orgSignInClient();
    await client.listOrganizations();

    expect(identityFetch).toHaveBeenCalledWith(
      "/v1/organizations",
      expect.objectContaining({ method: "GET" }),
    );
    expect(client.redirectUri()).toBe(
      "https://id.example/v1/federated/callback",
    );
  });

  it("escapes an id into one path segment", async () => {
    const { client, fetch } = fake({});
    const org: OrgSignInOrganization = {
      id: "org/../x",
      slug: "x",
      displayName: "X",
      role: "owner",
      owner: true,
      secretStored: false,
      upstream: {
        ssoIssuer: "",
        ssoClientId: "",
        ssoClientSecret: "",
        samlIssuer: "",
        samlMetadataUrl: "",
      },
    };
    await client.listDomains(org).catch(() => undefined);
    expect(fetch.mock.calls[0]?.[0]).toBe(
      "/v1/organizations/org%2F..%2Fx/domains",
    );
  });
});
