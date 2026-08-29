import { type BoundaryValue, overlapCast } from "@opensesame/os-domain";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  DirectoryError,
  addOrgMember,
  createOAuthClient,
  createOrganization,
  getMe,
  listLinkedIdentities,
  listOAuthClients,
  listOrgMembers,
  removeOrgMember,
  revokeOAuthClient,
  rotateOAuthClient,
  unlinkIdentity,
} from "./directory.js";

const identityFetch = vi.hoisted(() => vi.fn());

import { identitySeams } from "./identity.js";
Object.assign(identitySeams, {
  identityFetch,
  identityBase: () => "http://127.0.0.1:8788",
});

type LastCall = { url: string; init: RequestInit };

function jsonResponse(body: BoundaryValue, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function lastCall(): LastCall {
  const call = identityFetch.mock.calls.at(-1);
  if (!call) throw new Error("identityFetch was not called");
  return { url: String(call[0]), init: call[1] ? overlapCast(call[1]) : {} };
}

/** Await a call expected to fail, returning the thrown error as an Error. */
async function failureOf(
  promise: Promise<BoundaryValue> | Promise<void>,
): Promise<Error> {
  try {
    await promise;
  } catch (caught) {
    return caught instanceof Error ? caught : new Error(String(caught));
  }
  throw new Error("expected the call to fail");
}

type ClientWireOverrides = { id?: string; state?: string };

function clientWire(overrides: ClientWireOverrides = {}) {
  return {
    id: "cli_1",
    ownerPrincipalId: "prn_op",
    admissionMode: "pre_registered",
    displayName: "Release pipeline",
    redirectUris: ["https://ci.example.com/callback"],
    sectorIdentifier: "https://ci.example.com",
    grantTypes: ["authorization_code", "refresh_token"],
    responseTypes: ["code"],
    tokenEndpointAuthMethod: "none",
    allowedScopes: ["openid"],
    allowedResources: [],
    state: "active",
    createdAt: "2026-08-01T00:00:00Z",
    updatedAt: "2026-08-01T00:00:00Z",
    ...overrides,
  };
}

describe("directory client", () => {
  beforeEach(() => {
    identityFetch.mockReset();
  });

  it("reads the principal from /v1/principals/me", async () => {
    identityFetch.mockResolvedValue(
      jsonResponse({
        id: "prn_op",
        state: "active",
        assurance: "verified",
        createdAt: "2026-08-01T00:00:00Z",
        updatedAt: "2026-08-10T00:00:00Z",
        verifiedAt: "2026-08-02T00:00:00Z",
        version: 3,
        identities: [],
      }),
    );
    const me = await getMe();
    expect(lastCall().url).toBe("/v1/principals/me");
    expect(me).toEqual({
      id: "prn_op",
      state: "active",
      assurance: "verified",
      createdAt: "2026-08-01T00:00:00Z",
      verifiedAt: "2026-08-02T00:00:00Z",
      version: 3,
    });
  });

  it("lists linked identities with hints and link dates", async () => {
    identityFetch.mockResolvedValue(
      jsonResponse({
        identities: [
          {
            id: "xid_1",
            kind: "oidc",
            issuer: "https://accounts.google.com",
            subject: "sub-1",
            displayHint: "ada@example.com",
            assurance: "verified",
            linkedAt: "2026-08-03T00:00:00Z",
          },
          {
            id: "xid_2",
            kind: "passkey",
            issuer: "https://id.example.com",
            assurance: "phishing_resistant",
          },
        ],
      }),
    );
    const identities = await listLinkedIdentities();
    expect(lastCall().url).toBe("/v1/principals/identities");
    expect(identities).toEqual([
      {
        id: "xid_1",
        kind: "oidc",
        issuer: "https://accounts.google.com",
        displayHint: "ada@example.com",
        assurance: "verified",
        linkedAt: "2026-08-03T00:00:00Z",
      },
      {
        id: "xid_2",
        kind: "passkey",
        issuer: "https://id.example.com",
        assurance: "phishing_resistant",
      },
    ]);
  });

  it("unlinks an identity by id", async () => {
    identityFetch.mockResolvedValue(
      jsonResponse({ deleted: true, id: "xid_1" }),
    );
    await unlinkIdentity("xid_1");
    expect(lastCall().url).toBe("/v1/principals/identities/xid_1");
    expect(lastCall().init.method).toBe("DELETE");
  });

  it("lists OAuth clients with the owner-fenced fields", async () => {
    identityFetch.mockResolvedValue(jsonResponse({ clients: [clientWire()] }));
    const clients = await listOAuthClients();
    expect(lastCall().url).toBe("/v1/oauth/clients");
    expect(clients).toEqual([
      {
        id: "cli_1",
        displayName: "Release pipeline",
        admissionMode: "pre_registered",
        state: "active",
        redirectUris: ["https://ci.example.com/callback"],
        sectorIdentifier: "https://ci.example.com",
        tokenEndpointAuthMethod: "none",
        allowedScopes: ["openid"],
        createdAt: "2026-08-01T00:00:00Z",
        updatedAt: "2026-08-01T00:00:00Z",
      },
    ]);
  });

  it("creates an OAuth client with only the required fields sent", async () => {
    identityFetch.mockResolvedValue(jsonResponse(clientWire(), 201));
    const created = await createOAuthClient({
      displayName: "Release pipeline",
      redirectUris: ["https://ci.example.com/callback"],
      sectorIdentifier: "https://ci.example.com",
    });
    expect(lastCall().url).toBe("/v1/oauth/clients");
    expect(String(lastCall().init.body)).toBe(
      JSON.stringify({
        displayName: "Release pipeline",
        redirectUris: ["https://ci.example.com/callback"],
        sectorIdentifier: "https://ci.example.com",
      }),
    );
    expect(created.id).toBe("cli_1");
  });

  it("rotates by POSTing to /:id/rotate and returns the new client id", async () => {
    identityFetch.mockResolvedValue(
      jsonResponse(clientWire({ id: "cli_2" }), 201),
    );
    const rotated = await rotateOAuthClient("cli_1");
    expect(lastCall().url).toBe("/v1/oauth/clients/cli_1/rotate");
    expect(lastCall().init.method).toBe("POST");
    expect(rotated.id).toBe("cli_2");
  });

  it("revokes by POSTing to /:id/revoke", async () => {
    identityFetch.mockResolvedValue(
      jsonResponse(clientWire({ state: "revoked" })),
    );
    const revoked = await revokeOAuthClient("cli_1");
    expect(lastCall().url).toBe("/v1/oauth/clients/cli_1/revoke");
    expect(revoked.state).toBe("revoked");
  });

  it("lists org members with role chips", async () => {
    identityFetch.mockResolvedValue(
      jsonResponse({
        members: [
          {
            organizationId: "org:1",
            principalId: "prn_op",
            role: "owner",
            createdAt: "2026-08-01T00:00:00Z",
            updatedAt: "2026-08-01T00:00:00Z",
          },
        ],
      }),
    );
    const members = await listOrgMembers("org:1");
    expect(lastCall().url).toBe("/v1/organizations/org%3A1/members");
    expect(members).toEqual([
      {
        organizationId: "org:1",
        principalId: "prn_op",
        role: "owner",
        createdAt: "2026-08-01T00:00:00Z",
      },
    ]);
  });

  it("adds a member by principal id and role", async () => {
    identityFetch.mockResolvedValue(
      jsonResponse(
        {
          organizationId: "org:1",
          principalId: "prn_new",
          role: "member",
          createdAt: "2026-08-29T00:00:00Z",
          updatedAt: "2026-08-29T00:00:00Z",
        },
        201,
      ),
    );
    const added = await addOrgMember("org:1", "prn_new", "member");
    expect(String(lastCall().init.body)).toBe(
      JSON.stringify({ principalId: "prn_new", role: "member" }),
    );
    expect(added.principalId).toBe("prn_new");
  });

  it("removes a member, accepting the 204 with no body", async () => {
    identityFetch.mockResolvedValue(new Response(null, { status: 204 }));
    await removeOrgMember("org:1", "prn_new");
    expect(lastCall().url).toBe("/v1/organizations/org%3A1/members/prn_new");
    expect(lastCall().init.method).toBe("DELETE");
  });

  it("creates an organization, sending ssoIssuer only when given", async () => {
    identityFetch.mockResolvedValue(
      jsonResponse(
        {
          id: "org:2",
          slug: "acme-corp",
          displayName: "Acme Corp",
          state: "active",
          role: "owner",
          createdBy: "prn_op",
          createdAt: "2026-08-29T00:00:00Z",
          updatedAt: "2026-08-29T00:00:00Z",
          ssoIssuer: "https://login.acme.com",
        },
        201,
      ),
    );
    const org = await createOrganization({
      slug: "acme-corp",
      displayName: "Acme Corp",
      ssoIssuer: "https://login.acme.com",
    });
    expect(String(lastCall().init.body)).toBe(
      JSON.stringify({
        slug: "acme-corp",
        displayName: "Acme Corp",
        ssoIssuer: "https://login.acme.com",
      }),
    );
    expect(org).toMatchObject({
      id: "org:2",
      slug: "acme-corp",
      role: "owner",
      ssoIssuer: "https://login.acme.com",
    });

    identityFetch.mockResolvedValue(
      jsonResponse(
        {
          id: "org:3",
          slug: "plain",
          displayName: "Plain",
          state: "active",
          role: "owner",
          createdBy: "prn_op",
          createdAt: "2026-08-29T00:00:00Z",
          updatedAt: "2026-08-29T00:00:00Z",
        },
        201,
      ),
    );
    await createOrganization({ slug: "plain", displayName: "Plain" });
    expect(String(lastCall().init.body)).toBe(
      JSON.stringify({ slug: "plain", displayName: "Plain" }),
    );
  });

  it("maps 401 to sign-in wording", async () => {
    identityFetch.mockResolvedValue(
      jsonResponse({ error: "unauthorized" }, 401),
    );
    const error = await failureOf(getMe());
    expect(error).toBeInstanceOf(DirectoryError);
    expect(error.message).toMatch(/signed-in session/);
  });

  it("maps 403 to the owner fence when the server gives no message", async () => {
    identityFetch.mockResolvedValue(
      jsonResponse({ error: "owner_required" }, 403),
    );
    const error = await failureOf(listOrgMembers("org:1"));
    expect(error).toBeInstanceOf(DirectoryError);
    if (error instanceof DirectoryError) {
      expect(error.status).toBe(403);
      expect(error.code).toBe("owner_required");
    }
    expect(error.message).toMatch(/Only the owner/);
  });

  it("prefers the server's own plain message when it sends one", async () => {
    identityFetch.mockResolvedValue(
      jsonResponse(
        {
          error: "assurance_too_low",
          message: "Verified identity required to create an organization",
        },
        403,
      ),
    );
    const error = await failureOf(
      createOrganization({ slug: "acme", displayName: "Acme" }),
    );
    expect(error.message).toBe(
      "Verified identity required to create an organization",
    );
  });

  it("maps 404 to may-already-be-gone wording", async () => {
    identityFetch.mockResolvedValue(jsonResponse({ error: "not_found" }, 404));
    const error = await failureOf(unlinkIdentity("xid_nope"));
    expect(error.message).toMatch(/may already be gone/);
  });

  it("maps network failures to an unreachable-Identity error", async () => {
    identityFetch.mockRejectedValue(new TypeError("fetch failed"));
    const error = await failureOf(listOAuthClients());
    expect(error).toBeInstanceOf(DirectoryError);
    if (error instanceof DirectoryError) {
      expect(error.code).toBe("unreachable");
    }
    expect(error.message).toMatch(
      /Identity API unreachable at http:\/\/127\.0\.0\.1:8788/,
    );
  });
});
