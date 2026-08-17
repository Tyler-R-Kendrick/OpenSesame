import { beforeEach, describe, expect, it, vi } from "vitest";

const hostFetch = vi.hoisted(() => vi.fn());
vi.mock("./identity.js", () => ({ hostFetch }));

import {
  getBackupStatus,
  installationIdFromLocation,
  putBackupTarget,
  filterGithubBackupConnections,
  filterPrivateGithubRepos,
  listGithubInstallations,
  branchForEnvironment,
  ownerRepoFromRemote,
} from "./backup.js";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("backup workflow client", () => {
  beforeEach(() => {
    hostFetch.mockReset();
  });

  it("reads target and queue depth from Host", async () => {
    hostFetch.mockResolvedValue(
      jsonResponse(200, {
        target: {
          integration_id: "int-1",
          installation_id: "777",
          owner: "acme",
          repo: "opensesame-passwords",
          branch: "main",
          enabled: true,
          status: "ok",
          last_commit_sha: "abc",
          last_synced_at: "2026-08-17T00:00:00Z",
          last_error: null,
        },
        pending_events: 2,
      }),
    );
    const status = await getBackupStatus();
    expect(status.pendingEvents).toBe(2);
    expect(status.target?.repo).toBe("opensesame-passwords");
    expect(status.target?.status).toBe("ok");
  });

  it("configures a target with snake_case wire fields", async () => {
    hostFetch.mockResolvedValue(
      jsonResponse(200, {
        target: {
          integration_id: "int-1",
          installation_id: "777",
          owner: "acme",
          repo: "r",
          branch: "main",
          enabled: true,
          status: "pending",
        },
      }),
    );
    await putBackupTarget({
      connectionId: "conn_1",
      installationId: "777",
      owner: "acme",
      repo: "r",
    });
    const [, init] = hostFetch.mock.calls[0] as [string, RequestInit];
    const sent = JSON.parse(String(init.body));
    expect(sent.connection_id).toBe("conn_1");
    expect(sent.installation_id).toBe("777");
    expect(sent.owner).toBe("acme");
  });

  it("maps remotes and environments to owner/repo/branch", () => {
    expect(ownerRepoFromRemote("https://github.com/acme/opensesame-passwords.git")).toEqual({
      owner: "acme",
      repo: "opensesame-passwords",
    });
    expect(branchForEnvironment("production")).toBe("env/production");
    expect(branchForEnvironment("development")).toBe("env/development");
  });

  it("lists only GitHub History connections for recoverability", () => {
    const filtered = filterGithubBackupConnections([
      { providerId: "github", status: "active" },
      { providerId: "github", status: "needs_reauth" },
      { providerId: "github", status: "revoked" },
      { providerId: "stripe", status: "active" },
      { providerId: "openai", status: "active" },
    ]);
    expect(filtered).toEqual([
      { providerId: "github", status: "active" },
      { providerId: "github", status: "needs_reauth" },
    ]);
  });

  it("keeps only private https repos in the recoverability picker", () => {
    expect(
      filterPrivateGithubRepos([
        {
          private: true,
          cloneUrl: "https://github.com/acme/opensesame-passwords.git",
        },
        {
          private: false,
          cloneUrl: "https://github.com/acme/public.git",
        },
        {
          private: true,
          cloneUrl: "git@github.com:acme/ssh-only.git",
        },
      ]),
    ).toEqual([
      {
        private: true,
        cloneUrl: "https://github.com/acme/opensesame-passwords.git",
      },
    ]);
  });

  it("lists App installations from Host", async () => {
    hostFetch.mockResolvedValue(
      jsonResponse(200, {
        installations: [
          {
            id: "55",
            account_login: "acme",
            account_type: "Organization",
            target_type: "Organization",
          },
          { id: "bad", account_login: "x", account_type: "User", target_type: "User" },
        ],
      }),
    );
    const rows = await listGithubInstallations("int-1");
    expect(hostFetch.mock.calls[0]?.[0]).toContain(
      "/api/v1/integrations/int-1/github/installations",
    );
    expect(rows).toEqual([
      {
        id: "55",
        accountLogin: "acme",
        accountType: "Organization",
        targetType: "Organization",
      },
    ]);
  });

  it("surfaces the server hint on refusal", async () => {
    hostFetch.mockResolvedValue(
      jsonResponse(422, {
        error: "integration_unusable",
        hint: "register the app first",
      }),
    );
    await expect(
      putBackupTarget({
        integrationId: "x",
        installationId: "1",
        owner: "a",
        repo: "b",
      }),
    ).rejects.toThrow(/register the app first/);
  });

  it("builds a GitHub App install URL from html_url or display name", async () => {
    const { githubAppInstallUrl } = await import("./backup.js");
    expect(
      githubAppInstallUrl({
        htmlUrl: "https://github.com/apps/opensesame-recoverability",
      }),
    ).toBe(
      "https://github.com/apps/opensesame-recoverability/installations/new",
    );
    expect(
      githubAppInstallUrl({ displayName: "OpenSesame Recoverability" }),
    ).toBe(
      "https://github.com/apps/opensesame-recoverability/installations/new",
    );
    expect(githubAppInstallUrl({})).toBeNull();
  });

  it("extracts the installation id GitHub appends to the setup redirect", () => {
    expect(
      installationIdFromLocation(
        "?installation_id=123456&setup_action=install",
      ),
    ).toBe("123456");
    expect(installationIdFromLocation("?installation_id=evil'--")).toBeNull();
    expect(installationIdFromLocation("")).toBeNull();
  });
});
