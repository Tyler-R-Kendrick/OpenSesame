import type { BoundaryValue } from "@opensesame/os-domain";
import { beforeEach, describe, expect, it, vi } from "vitest";

const hostFetch = vi.hoisted(() =>
  vi.fn<(path: string, init?: RequestInit) => Promise<Response>>(),
);
import { identitySeams } from "./identity.js";
const originalIdentitySeams = { ...identitySeams };
Object.assign(identitySeams, { hostFetch });
import {
  branchForEnvironment,
  filterGithubBackupConnections,
  filterPrivateGithubRepos,
  getBackupStatus,
  installationIdFromLocation,
  listGithubInstallations,
  ownerRepoFromRemote,
  putBackupTarget,
} from "./backup.js";

function jsonResponse(status: number, body: BoundaryValue): Response {
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
    const init = hostFetch.mock.calls[0]?.[1];
    if (!init) throw new Error("Host request was not recorded");
    const sent = JSON.parse(String(init.body));
    expect(sent.connection_id).toBe("conn_1");
    expect(sent.installation_id).toBe("777");
    expect(sent.owner).toBe("acme");
  });

  it("maps remotes and environments to owner/repo/branch", () => {
    expect(
      ownerRepoFromRemote("https://github.com/acme/opensesame-passwords.git"),
    ).toEqual({
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
          {
            id: "bad",
            account_login: "x",
            account_type: "User",
            target_type: "User",
          },
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

describe("backup workflow edge cases", () => {
  beforeEach(() => {
    hostFetch.mockReset();
  });

  it("reports an unset target with an empty queue", async () => {
    hostFetch.mockResolvedValue(jsonResponse(200, { target: null }));
    await expect(getBackupStatus()).resolves.toEqual({
      target: null,
      pendingEvents: 0,
    });
  });

  it("surfaces hint, error, then status when reads fail", async () => {
    hostFetch.mockResolvedValue(jsonResponse(403, { hint: "owner only" }));
    await expect(getBackupStatus()).rejects.toThrow(/owner only/);

    hostFetch.mockResolvedValue(jsonResponse(500, { error: "backup_broken" }));
    await expect(getBackupStatus()).rejects.toThrow(/backup_broken/);

    hostFetch.mockResolvedValue(new Response("no", { status: 502 }));
    await expect(getBackupStatus()).rejects.toThrow(
      /Could not read backup status \(502\)/,
    );
  });

  it("drops non-numeric and non-object installation rows", async () => {
    hostFetch.mockResolvedValue(
      jsonResponse(200, { installations: [null, "x", { id: "12" }] }),
    );
    await expect(listGithubInstallations("int-1")).resolves.toEqual([
      { id: "12", accountLogin: "", accountType: "", targetType: "" },
    ]);
    hostFetch.mockResolvedValue(jsonResponse(200, {}));
    await expect(listGithubInstallations("int-1")).resolves.toEqual([]);
    hostFetch.mockResolvedValue(jsonResponse(403, { hint: "no access" }));
    await expect(listGithubInstallations("int-1")).rejects.toThrow(/no access/);
  });

  it("sends optional target fields only when set", async () => {
    hostFetch.mockResolvedValue(
      jsonResponse(200, {
        target: { owner: "acme", repo: "r", enabled: false, status: "ok" },
      }),
    );
    const target = await putBackupTarget({
      integrationId: "int-1",
      installationId: "9",
      owner: "acme",
      repo: "r",
      branch: "env/production",
      enabled: false,
    });
    const init = hostFetch.mock.calls[0]?.[1];
    if (!init) throw new Error("Host request was not recorded");
    expect(JSON.parse(String(init.body))).toEqual({
      integration_id: "int-1",
      installation_id: "9",
      owner: "acme",
      repo: "r",
      branch: "env/production",
      enabled: false,
    });
    // Defaults fill in for fields the API omits.
    expect(target.branch).toBe("main");
    expect(target.lastCommitSha).toBeNull();
  });

  it("removes the target and queues resyncs, surfacing failures", async () => {
    const { deleteBackupTarget, resyncBackup } = await import("./backup.js");

    hostFetch.mockResolvedValue(jsonResponse(200, {}));
    await expect(deleteBackupTarget()).resolves.toBeUndefined();
    expect(hostFetch.mock.calls[0]?.[1]).toMatchObject({ method: "DELETE" });

    hostFetch.mockResolvedValue(jsonResponse(409, { hint: "disable first" }));
    await expect(deleteBackupTarget()).rejects.toThrow(/disable first/);

    hostFetch.mockResolvedValue(jsonResponse(200, {}));
    await expect(resyncBackup()).resolves.toBeUndefined();
    expect(hostFetch.mock.calls[2]?.[0]).toContain("/api/v1/backup/resync");

    hostFetch.mockResolvedValue(jsonResponse(500, {}));
    await expect(resyncBackup()).rejects.toThrow(
      /Could not queue a resync \(500\)/,
    );
  });

  it("parses owner/repo from clone URLs and full names only", () => {
    expect(ownerRepoFromRemote("acme/opensesame-passwords")).toEqual({
      owner: "acme",
      repo: "opensesame-passwords",
    });
    // A trailing slash after .git is not unwrapped — only the slash is trimmed.
    expect(ownerRepoFromRemote("https://github.com/acme/store.git/")).toEqual({
      owner: "acme",
      repo: "store.git",
    });
    expect(ownerRepoFromRemote("https://github.com/acme")).toBeNull();
    expect(ownerRepoFromRemote("just-one-part")).toBeNull();
    expect(ownerRepoFromRemote("  ")).toBeNull();
  });

  it("sanitizes custom environment names into branch names", () => {
    expect(branchForEnvironment("staging")).toBe("env/staging");
    expect(branchForEnvironment("blue green!")).toBe("env/blue-green-");
  });

  it("explains known GitHub App failure codes plainly", async () => {
    const { githubAppFailureReason } = await import("./backup.js");
    expect(githubAppFailureReason(null)).toBe("unknown error");
    expect(githubAppFailureReason("  ")).toBe("unknown error");
    expect(githubAppFailureReason("missing_state")).toMatch(
      /incomplete redirect/,
    );
    expect(githubAppFailureReason("missing_code")).toMatch(
      /incomplete redirect/,
    );
    expect(githubAppFailureReason("unknown_or_expired_state")).toMatch(
      /expired/,
    );
    expect(githubAppFailureReason("expired_state")).toMatch(/expired/);
    expect(githubAppFailureReason("conversion_failed")).toMatch(
      /one-time code/,
    );
    expect(githubAppFailureReason("something_else")).toBe("something_else");
  });

  it("refuses to build an install URL from a non-Github page or an empty name", async () => {
    const { githubAppInstallUrl } = await import("./backup.js");
    expect(
      githubAppInstallUrl({ htmlUrl: "https://evil.example/apps/x" }),
    ).toBeNull();
    expect(
      githubAppInstallUrl({
        htmlUrl: "https://github.com/apps/opensesame-recoverability/",
      }),
    ).toBe(
      "https://github.com/apps/opensesame-recoverability/installations/new",
    );
    expect(githubAppInstallUrl({ displayName: "!!!" })).toBeNull();
    expect(githubAppInstallUrl({ displayName: "" })).toBeNull();
  });
});
