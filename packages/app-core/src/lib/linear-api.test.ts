import type { BoundaryValue } from "@opensesame/os-domain";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createLinearIssue,
  createLinearWebhook,
  deleteLinearWebhook,
  exchangeLinearCode,
  linearApiSeams,
  listLinearIssues,
  listLinearProjects,
  listLinearWebhooks,
  readLinearIssue,
  readLinearProject,
  refreshLinearToken,
  revokeLinearToken,
  verifyLinearAccount,
} from "./linear-api.js";

const oauth = { kind: "oauth", token: "private-access-token" } as const;
const apiKey = { kind: "api-key", token: "lin_api_private" } as const;
const account = {
  viewer: { id: "user-1", name: "Casey", email: "casey@example.org" },
  organization: { id: "workspace-1", name: "Acme", urlKey: "acme" },
  teams: { nodes: [{ id: "team-1", name: "Engineering", key: "ENG" }] },
};
const issue = {
  id: "issue-1",
  identifier: "ENG-123",
  title: "Investigate regression",
  description: null,
  url: "https://linear.app/acme/issue/ENG-123",
};
const token = {
  access_token: "access-token",
  refresh_token: "refresh-token",
  token_type: "Bearer",
  expires_in: 86400,
  scope: "read write issues:create",
};

function answer(body: BoundaryValue, status = 200) {
  const fetcher = vi.fn(
    async (_url: RequestInfo | URL, _init?: RequestInit) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      }),
  );
  vi.stubGlobal("fetch", fetcher);
  return fetcher;
}

function request(fetcher: ReturnType<typeof answer>): RequestInit {
  const init = fetcher.mock.calls[0]?.[1];
  if (!init) throw new Error("Linear request not made");
  return init;
}

const inactiveFetch = linearApiSeams.fetch;
beforeEach(() => {
  linearApiSeams.fetch = (url, init) => fetch(url, init);
});
afterEach(() => {
  linearApiSeams.fetch = inactiveFetch;
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("Linear public PKCE transport", () => {
  it("exchanges a code at the real Linear token endpoint without a confidential secret", async () => {
    const fetcher = answer(token);
    const start = Date.now();
    const grant = await exchangeLinearCode({
      clientId: "client-1",
      code: "one-time-code",
      verifier: "v".repeat(43),
      redirectUri: "https://app.example.org/OpenSesame/",
    });
    expect(grant.accessToken).toBe("access-token");
    expect(grant.refreshToken).toBe("refresh-token");
    expect(grant.scopes).toEqual(["read", "write", "issues:create"]);
    expect(grant.expiresAt).toBeGreaterThanOrEqual(start + 86_400_000);
    expect(fetcher.mock.calls[0]?.[0]).toBe(
      "https://api.linear.app/oauth/token",
    );
    const init = request(fetcher);
    const form = new URLSearchParams(String(init.body));
    expect(Object.fromEntries(form)).toEqual({
      grant_type: "authorization_code",
      client_id: "client-1",
      code: "one-time-code",
      code_verifier: "v".repeat(43),
      redirect_uri: "https://app.example.org/OpenSesame/",
    });
    expect(init).toMatchObject({
      method: "POST",
      credentials: "omit",
      redirect: "error",
      cache: "no-store",
      referrerPolicy: "no-referrer",
    });
  });

  it("accepts legacy scope arrays and rotates refresh tokens using only the PKCE client ID", async () => {
    const fetcher = answer({
      ...token,
      refresh_token: "rotated-refresh",
      scope: ["read", "read", "write"],
    });
    const grant = await refreshLinearToken({
      clientId: "client-1",
      refreshToken: "old-refresh",
    });
    expect(grant.refreshToken).toBe("rotated-refresh");
    expect(grant.scopes).toEqual(["read", "write"]);
    expect(
      Object.fromEntries(new URLSearchParams(String(request(fetcher).body))),
    ).toEqual({
      grant_type: "refresh_token",
      client_id: "client-1",
      refresh_token: "old-refresh",
    });
  });

  it("never promotes an invalid expiry or missing grant into authorization", async () => {
    answer({ ...token, expires_in: 0 });
    await expect(
      refreshLinearToken({ clientId: "client-1", refreshToken: "old" }),
    ).rejects.toMatchObject({ code: "response" });
    answer({
      access_token: "access",
      token_type: "Basic",
      expires_in: 86400,
      scope: "read",
    });
    await expect(
      refreshLinearToken({ clientId: "client-1", refreshToken: "old" }),
    ).rejects.toMatchObject({ code: "response" });
  });

  it("revokes OAuth with Linear's current token form and never sends personal API keys to the OAuth revoke route", async () => {
    const fetcher = answer(null);
    await revokeLinearToken(oauth);
    expect(fetcher.mock.calls[0]?.[0]).toBe(
      "https://api.linear.app/oauth/revoke",
    );
    expect(
      Object.fromEntries(new URLSearchParams(String(request(fetcher).body))),
    ).toEqual({ token: oauth.token, token_type_hint: "access_token" });
    await expect(revokeLinearToken(apiKey)).rejects.toMatchObject({
      code: "input",
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});

describe("Linear's actual GraphQL operations", () => {
  it.each([oauth, apiKey])(
    "verifies the viewer, real workspace and team identity for $kind",
    async (credential) => {
      const fetcher = answer({ data: account });
      await expect(verifyLinearAccount(credential)).resolves.toEqual({
        ...account,
        teams: account.teams.nodes,
      });
      expect(fetcher.mock.calls[0]?.[0]).toBe("https://api.linear.app/graphql");
      const init = request(fetcher);
      expect(new Headers(init.headers).get("authorization")).toBe(
        credential.kind === "oauth"
          ? `Bearer ${credential.token}`
          : credential.token,
      );
      const packed: BoundaryValue = JSON.parse(String(init.body));
      expect(packed).toMatchObject({ variables: {} });
      expect(String(init.body)).toContain("organization { id name urlKey }");
      expect(String(init.body)).not.toContain(credential.token);
    },
  );

  it("reads issues and projects with GraphQL variables instead of invented REST paths", async () => {
    const fetcher = answer({ data: { issue } });
    await expect(readLinearIssue(oauth, "ENG-123")).resolves.toEqual(issue);
    expect(JSON.parse(String(request(fetcher).body))).toMatchObject({
      variables: { id: "ENG-123" },
    });
    expect(String(request(fetcher).body)).toContain("issue(id: $id)");
    const project = {
      id: "project-1",
      name: "New release",
      description: "Release work",
      url: "https://linear.app/acme/project/release",
    };
    const projectFetch = answer({ data: { project } });
    await expect(readLinearProject(oauth, "project-1")).resolves.toEqual(
      project,
    );
    expect(String(request(projectFetch).body)).toContain("project(id: $id)");
  });

  it("lists bounded real issue and project results", async () => {
    const fetcher = answer({ data: { issues: { nodes: [issue] } } });
    await expect(listLinearIssues(oauth)).resolves.toEqual([issue]);
    expect(String(request(fetcher).body)).toContain(
      "issues(first: 50, orderBy: updatedAt)",
    );
    expect(String(request(fetcher).body)).not.toContain("description");
    const project = {
      id: "project-1",
      name: "Release",
      description: "",
      url: "https://linear.app/acme/project/release",
    };
    answer({ data: { projects: { nodes: [project] } } });
    await expect(listLinearProjects(oauth)).resolves.toEqual([project]);
  });

  it("creates an issue with a validated team and safely preserves arbitrary title text", async () => {
    const fetcher = answer({ data: { issueCreate: { success: true, issue } } });
    const title = 'Fix "query { users }"';
    await expect(
      createLinearIssue(oauth, { teamId: "team-1", title }),
    ).resolves.toEqual(issue);
    expect(JSON.parse(String(request(fetcher).body))).toMatchObject({
      variables: { input: { teamId: "team-1", title } },
    });
    await expect(
      createLinearIssue(oauth, { teamId: "", title: "" }),
    ).rejects.toMatchObject({ code: "input" });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("requires a positive mutation result and rejects partial GraphQL errors", async () => {
    answer({ data: { issueCreate: { success: false, issue } } });
    await expect(
      createLinearIssue(oauth, { teamId: "team-1", title: "Draft" }),
    ).rejects.toMatchObject({ code: "response" });
    answer({
      data: account,
      errors: [
        { message: `secret ${oauth.token}`, extensions: { code: "FORBIDDEN" } },
      ],
    });
    await expect(verifyLinearAccount(oauth)).rejects.toMatchObject({
      code: "permission",
    });
  });

  it("creates and removes actual Linear webhooks for the selected resource types", async () => {
    const fetcher = answer({
      data: {
        webhookCreate: {
          success: true,
          webhook: { id: "webhook-1", enabled: true },
        },
      },
    });
    await expect(
      createLinearWebhook(oauth, {
        url: "https://hooks.example.org/linear",
        resourceTypes: ["Issue", "Comment", "Issue"],
        label: "My connector",
      }),
    ).resolves.toEqual({ id: "webhook-1", enabled: true });
    expect(JSON.parse(String(request(fetcher).body))).toMatchObject({
      variables: {
        input: {
          url: "https://hooks.example.org/linear",
          resourceTypes: ["Issue", "Comment"],
          label: "My connector",
          allPublicTeams: true,
        },
      },
    });
    const deletion = answer({ data: { webhookDelete: { success: true } } });
    await deleteLinearWebhook(oauth, "webhook-1");
    expect(JSON.parse(String(request(deletion).body))).toMatchObject({
      variables: { id: "webhook-1" },
    });
  });

  it("does not send credentials to a webhook receiver and refuses invalid webhook destinations", async () => {
    const fetcher = answer({
      data: {
        webhookCreate: {
          success: true,
          webhook: { id: "webhook-2", enabled: true },
        },
      },
    });
    await createLinearWebhook(oauth, {
      url: "https://hooks.example.org/linear",
      teamId: "team-1",
      resourceTypes: ["Issue"],
    });
    expect(fetcher.mock.calls[0]?.[0]).toBe("https://api.linear.app/graphql");
    expect(JSON.parse(String(request(fetcher).body))).toMatchObject({
      variables: { input: { teamId: "team-1" } },
    });
    expect(String(request(fetcher).body)).not.toContain("allPublicTeams");
    await expect(
      createLinearWebhook(oauth, {
        url: "http://insecure.example.org",
        resourceTypes: ["Issue"],
      }),
    ).rejects.toMatchObject({ code: "input" });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("provisions a recoverable webhook ID and signing secret only at Linear", async () => {
    const fetcher = answer({
      data: {
        webhookCreate: {
          success: true,
          webhook: { id: "webhook-1", enabled: true },
        },
      },
    });
    const id = "11398d9d-514e-4008-9b6d-b24cb3b4e382";
    const secret = "s".repeat(64);
    await createLinearWebhook(oauth, {
      id,
      secret,
      url: "https://hooks.example.org/linear",
      resourceTypes: ["Issue"],
    });
    expect(JSON.parse(String(request(fetcher).body))).toMatchObject({
      variables: { input: { id, secret } },
    });
    expect(fetcher.mock.calls[0]?.[0]).toBe("https://api.linear.app/graphql");
  });

  it("paginates webhook reconciliation metadata and refuses broken cursor loops", async () => {
    const first = {
      id: "webhook-1",
      enabled: true,
      url: "https://hooks.example.org/linear",
      label: "My connector",
      resourceTypes: ["Issue"],
    };
    const second = { ...first, id: "webhook-2", url: null, label: null };
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            data: {
              webhooks: {
                nodes: [first],
                pageInfo: { hasNextPage: true, endCursor: "cursor-1" },
              },
            },
          }),
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            data: {
              webhooks: {
                nodes: [second],
                pageInfo: { hasNextPage: false, endCursor: null },
              },
            },
          }),
        ),
      );
    vi.stubGlobal("fetch", fetcher);
    await expect(listLinearWebhooks(oauth)).resolves.toEqual([first, second]);
    expect(JSON.parse(String(fetcher.mock.calls[1]?.[1]?.body))).toMatchObject({
      variables: { after: "cursor-1" },
    });
    answer({
      data: {
        webhooks: {
          nodes: [],
          pageInfo: { hasNextPage: true, endCursor: null },
        },
      },
    });
    await expect(listLinearWebhooks(oauth)).rejects.toMatchObject({
      code: "response",
    });
  });
});
