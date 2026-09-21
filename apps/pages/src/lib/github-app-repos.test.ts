import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  githubAppRepoSeams,
  listGithubAppInstallationRepos,
} from "./github-app-repos.js";

const original = { ...githubAppRepoSeams };
const postRelay = vi.fn();

beforeEach(() => {
  Object.assign(githubAppRepoSeams, {
    credentials: () => ({
      appId: "1",
      pem: "PEM",
      installs: [
        {
          installationId: "99",
          accountLogin: "octocat",
          accountType: "User",
        },
      ],
    }),
    postRelay,
  });
  postRelay.mockReset();
});

afterEach(() => {
  Object.assign(githubAppRepoSeams, original);
});

it("returns every private install repository from the relay", async () => {
  const repositories = Array.from({ length: 120 }, (_, index) => ({
    fullName: `octocat/repo-${index + 1}`,
    name: `repo-${index + 1}`,
    private: true,
    defaultBranch: "main",
  }));
  postRelay.mockResolvedValue({
    ok: true,
    status: 200,
    payload: { repositories },
  });
  const listed = await listGithubAppInstallationRepos();
  expect(listed.error).toBeNull();
  expect(listed.repositories).toHaveLength(120);
  expect(listed.repositories[0]?.fullName).toBe("octocat/repo-1");
  expect(listed.repositories[119]?.fullName).toBe("octocat/repo-120");
});

it("drops public repositories from the install list", async () => {
  postRelay.mockResolvedValue({
    ok: true,
    status: 200,
    payload: {
      repositories: [
        {
          fullName: "octocat/private-vault",
          name: "private-vault",
          private: true,
          defaultBranch: "main",
        },
        {
          fullName: "octocat/public-site",
          name: "public-site",
          private: false,
          defaultBranch: "main",
        },
      ],
    },
  });
  const listed = await listGithubAppInstallationRepos();
  expect(listed.error).toBeNull();
  expect(listed.repositories.map((row) => row.fullName)).toEqual([
    "octocat/private-vault",
  ]);
});

it("surfaces a relay failure instead of an empty success", async () => {
  postRelay.mockResolvedValue({
    ok: false,
    status: 403,
    payload: { message: "Resource not accessible by integration" },
  });
  const listed = await listGithubAppInstallationRepos();
  expect(listed.repositories).toEqual([]);
  expect(listed.error).toBe("Resource not accessible by integration");
});

it("asks for an unlocked vault when App credentials are missing", async () => {
  Object.assign(githubAppRepoSeams, {
    credentials: () => null,
  });
  const listed = await listGithubAppInstallationRepos();
  expect(listed.repositories).toEqual([]);
  expect(listed.error).toMatch(/Unlock the vault/u);
});

it("keeps an error when one install fails beside a successful list", async () => {
  Object.assign(githubAppRepoSeams, {
    credentials: () => ({
      appId: "1",
      pem: "PEM",
      installs: [
        {
          installationId: "99",
          accountLogin: "octocat",
          accountType: "User",
        },
        {
          installationId: "88",
          accountLogin: "acme",
          accountType: "Organization",
        },
      ],
    }),
  });
  postRelay.mockImplementation(
    async (_path: string, body: { installationId?: string }) => {
      if (body.installationId === "88") {
        return {
          ok: false,
          status: 403,
          payload: { message: "Resource not accessible by integration" },
        };
      }
      return {
        ok: true,
        status: 200,
        payload: {
          repositories: [
            {
              fullName: "octocat/vault",
              name: "vault",
              private: true,
              defaultBranch: "main",
            },
          ],
        },
      };
    },
  );
  const listed = await listGithubAppInstallationRepos();
  expect(listed.repositories.map((row) => row.fullName)).toEqual([
    "octocat/vault",
  ]);
  expect(listed.error).toBe("Resource not accessible by integration");
});
