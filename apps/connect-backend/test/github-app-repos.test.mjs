import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  handleGithubAppCreateRepo,
  handleGithubAppInstallationRepos,
} from "../github-app-repos.mjs";

describe("github app installation repos", () => {
  it("lists private repositories for an installation", async () => {
    const { generateKeyPairSync } = await import("node:crypto");
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const pem = privateKey.export({ type: "pkcs1", format: "pem" }).toString();
    const fetchImpl = async (url, init) => {
      if (String(url).includes("/access_tokens")) {
        return {
          ok: true,
          status: 201,
          text: async () => JSON.stringify({ token: "ghs_list" }),
        };
      }
      if (String(url).includes("/installation/repositories")) {
        return {
          ok: true,
          status: 200,
          text: async () =>
            JSON.stringify({
              repositories: [
                {
                  full_name: "octocat/secrets",
                  name: "secrets",
                  private: true,
                  default_branch: "main",
                },
                {
                  full_name: "octocat/public",
                  name: "public",
                  private: false,
                  default_branch: "main",
                },
              ],
            }),
        };
      }
      throw new Error(`unexpected ${url}`);
    };
    const outcome = await handleGithubAppInstallationRepos(
      { appId: "1", pem, installationId: "99" },
      "http://localhost:5180",
      fetchImpl,
    );
    assert.equal(outcome.status, 200);
    const body = JSON.parse(outcome.body);
    assert.equal(body.repositories.length, 2);
    assert.equal(body.repositories[0].fullName, "octocat/secrets");
  });

  it("creates a private repository under the install account", async () => {
    const { generateKeyPairSync } = await import("node:crypto");
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const pem = privateKey.export({ type: "pkcs1", format: "pem" }).toString();
    const fetchImpl = async (url, init) => {
      if (String(url).includes("/access_tokens")) {
        return {
          ok: true,
          status: 201,
          text: async () => JSON.stringify({ token: "ghs_create" }),
        };
      }
      if (String(url).includes("/user/repos") && init?.method === "POST") {
        return {
          ok: true,
          status: 201,
          text: async () =>
            JSON.stringify({
              full_name: "octocat/opensesame-passwords",
              name: "opensesame-passwords",
              private: true,
              default_branch: "main",
            }),
        };
      }
      throw new Error(`unexpected ${url}`);
    };
    const outcome = await handleGithubAppCreateRepo(
      {
        appId: "1",
        pem,
        installationId: "99",
        owner: "octocat",
        name: "opensesame-passwords",
        accountType: "User",
      },
      "http://localhost:5180",
      fetchImpl,
    );
    assert.equal(outcome.status, 200);
    const body = JSON.parse(outcome.body);
    assert.equal(body.repository.fullName, "octocat/opensesame-passwords");
  });
});
