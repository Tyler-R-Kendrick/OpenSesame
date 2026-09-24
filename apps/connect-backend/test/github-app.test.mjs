import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { describe, it } from "node:test";
import { handleGitBackupPut } from "../src/git-backup-put.mjs";
import {
  clearGithubAppWebhookPending,
  handleGithubAppPutContents,
  handleGithubAppWebhook,
  handleGithubAppWebhookPending,
} from "../src/github-app-contents.mjs";
import {
  handleGithubAppCallback,
  handleGithubAppConvert,
  handleGithubAppConvertOptions,
  handleGithubAppInstallations,
} from "../src/github-app.mjs";

describe("github app callback relay", () => {
  it("forwards code and state to a loopback return address", () => {
    const outcome = handleGithubAppCallback(
      "/api/github-app/callback?return_to=http%3A%2F%2Flocalhost%3A5180%2FOpenSesame%2Fconnections%2Fgithub&code=abc&state=xyz",
      "https://relay.example",
    );
    assert.equal(outcome.status, 302);
    assert.equal(
      outcome.headers.location,
      "http://localhost:5180/OpenSesame/connections/github?github_app_code=abc&github_app_state=xyz&github_app=claim",
    );
  });

  it("refuses an off-allowlist return address", () => {
    const outcome = handleGithubAppCallback(
      "/api/github-app/callback?return_to=https%3A%2F%2Fevil.example%2F&code=abc",
      "https://relay.example",
    );
    assert.equal(outcome.status, 400);
  });
});

describe("github app convert proxy", () => {
  it("proxies a successful conversion for a loopback origin", async () => {
    const { generateKeyPairSync } = await import("node:crypto");
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const pem = privateKey.export({ type: "pkcs1", format: "pem" }).toString();
    const fetchImpl = async (url) => {
      if (String(url).includes("/app-manifests/")) {
        return {
          ok: true,
          status: 201,
          text: async () =>
            JSON.stringify({
              id: 1,
              name: "OpenSesame",
              client_id: "Iv1.x",
              client_secret: "s",
              pem,
            }),
        };
      }
      if (String(url).endsWith("/app")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            owner: { login: "Tyler-R-Kendrick", type: "User" },
          }),
        };
      }
      throw new Error(`unexpected url ${url}`);
    };
    const outcome = await handleGithubAppConvert(
      { code: "temp" },
      "http://localhost:5180",
      fetchImpl,
    );
    assert.equal(outcome.status, 200);
    assert.equal(
      outcome.headers["access-control-allow-origin"],
      "http://localhost:5180",
    );
    assert.match(outcome.body, /"client_id":"Iv1.x"/);
    const body = JSON.parse(outcome.body);
    assert.equal(body.owner.login, "Tyler-R-Kendrick");
    assert.equal(body.owner.type, "User");
  });

  it("refuses a missing code", async () => {
    const outcome = await handleGithubAppConvert(
      {},
      "http://localhost:5180",
      async () => {
        throw new Error("should not fetch");
      },
    );
    assert.equal(outcome.status, 400);
  });

  it("answers CORS preflight for an allowed origin", () => {
    const outcome = handleGithubAppConvertOptions("http://127.0.0.1:5180");
    assert.equal(outcome.status, 204);
    assert.equal(
      outcome.headers["access-control-allow-origin"],
      "http://127.0.0.1:5180",
    );
  });
});

describe("github app installations list", () => {
  it("returns install accounts and the App owner from JWT /app", async () => {
    const { generateKeyPairSync } = await import("node:crypto");
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const pem = privateKey.export({ type: "pkcs1", format: "pem" }).toString();
    const fetchImpl = async (url) => {
      if (String(url).endsWith("/app/installations?per_page=100")) {
        return {
          ok: true,
          status: 200,
          text: async () =>
            JSON.stringify([
              {
                id: 162996763,
                account: { login: "acme-corp", type: "Organization" },
              },
            ]),
        };
      }
      if (String(url).endsWith("/app")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            id: 4997182,
            owner: { login: "Tyler-R-Kendrick", type: "User" },
          }),
        };
      }
      throw new Error(`unexpected url ${url}`);
    };
    const outcome = await handleGithubAppInstallations(
      { appId: "4997182", pem },
      "http://localhost:5180",
      fetchImpl,
    );
    assert.equal(outcome.status, 200);
    const body = JSON.parse(outcome.body);
    assert.equal(body.ownerLogin, "Tyler-R-Kendrick");
    assert.equal(body.ownerType, "User");
    assert.deepEqual(body.installations, [
      {
        id: "162996763",
        accountLogin: "acme-corp",
        accountType: "Organization",
      },
    ]);
  });
});

describe("github app put-contents proxy", () => {
  it("mints an attenuated token and upserts ciphertext", async () => {
    const { generateKeyPairSync } = await import("node:crypto");
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const pem = privateKey.export({ type: "pkcs1", format: "pem" }).toString();
    const calls = [];
    const fetchImpl = async (url, init) => {
      calls.push({
        url: String(url),
        method: init?.method ?? "GET",
        body: init?.body,
      });
      if (String(url).includes("/access_tokens")) {
        return {
          ok: true,
          status: 201,
          text: async () => JSON.stringify({ token: "ghs_test" }),
        };
      }
      if (String(url).includes("/contents/")) {
        if ((init?.method ?? "GET") === "GET") {
          return { ok: false, status: 404, text: async () => "{}" };
        }
        return {
          ok: true,
          status: 201,
          text: async () =>
            JSON.stringify({
              content: { sha: "blob" },
              commit: { sha: "commit123" },
            }),
        };
      }
      throw new Error(`unexpected ${url}`);
    };
    const outcome = await handleGithubAppPutContents(
      {
        appId: "1",
        pem,
        installationId: "99",
        owner: "acme",
        repo: "vault",
        contentBase64: Buffer.from("{}").toString("base64"),
      },
      "http://localhost:5180",
      fetchImpl,
    );
    assert.equal(outcome.status, 200);
    const body = JSON.parse(outcome.body);
    assert.equal(body.commitSha, "commit123");
    const tokenCall = calls.find((c) => c.url.includes("/access_tokens"));
    assert.ok(tokenCall);
    const tokenBody = JSON.parse(tokenCall.body);
    assert.deepEqual(tokenBody.repositories, ["vault"]);
    assert.equal(tokenBody.permissions.contents, "write");
  });
});

describe("github app webhook pending queue", () => {
  it("refuses enqueue when webhook secret is unset", async () => {
    clearGithubAppWebhookPending();
    const previous = process.env.GITHUB_WEBHOOK_SECRET;
    process.env.GITHUB_WEBHOOK_SECRET = "";
    const posted = await handleGithubAppWebhook(
      { installation: { id: 42 } },
      { "x-github-delivery": "del-1" },
      '{"installation":{"id":42}}',
    );
    assert.equal(posted.status, 503);
    if (previous === undefined) process.env.GITHUB_WEBHOOK_SECRET = "";
    else process.env.GITHUB_WEBHOOK_SECRET = previous;
  });

  it("refuses HMAC verify without the exact raw body", async () => {
    clearGithubAppWebhookPending();
    const previous = process.env.GITHUB_WEBHOOK_SECRET;
    process.env.GITHUB_WEBHOOK_SECRET = "test-webhook-secret";
    const body = { installation: { id: 42 } };
    const rawBody = JSON.stringify(body);
    const digest = createHmac("sha256", "test-webhook-secret")
      .update(rawBody)
      .digest("hex");
    const posted = await handleGithubAppWebhook(
      body,
      {
        "x-github-delivery": "del-missing-raw",
        "x-hub-signature-256": `sha256=${digest}`,
      },
      "",
    );
    assert.equal(posted.status, 401);
    assert.equal(posted.body, "raw_body_required");
    if (previous === undefined) process.env.GITHUB_WEBHOOK_SECRET = "";
    else process.env.GITHUB_WEBHOOK_SECRET = previous;
  });

  it("enqueues and drains webhook nudges with valid HMAC and App PEM", async () => {
    clearGithubAppWebhookPending();
    const previous = process.env.GITHUB_WEBHOOK_SECRET;
    process.env.GITHUB_WEBHOOK_SECRET = "test-webhook-secret";
    const { generateKeyPairSync } = await import("node:crypto");
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const pem = privateKey.export({ type: "pkcs8", format: "pem" });
    const body = { installation: { id: 42 } };
    const rawBody = JSON.stringify(body);
    const digest = createHmac("sha256", "test-webhook-secret")
      .update(rawBody)
      .digest("hex");
    const posted = await handleGithubAppWebhook(
      body,
      {
        "x-github-delivery": "del-1",
        "x-hub-signature-256": `sha256=${digest}`,
      },
      rawBody,
    );
    assert.equal(posted.status, 204);
    const denied = await handleGithubAppWebhookPending(
      {},
      "http://localhost:5180",
    );
    assert.equal(denied.status, 400);
    // GitHub confirms installation 42 belongs to App 1 before anything drains.
    const owns = async () => ({
      status: 200,
      text: async () => JSON.stringify({ id: 42, app_id: 1 }),
    });
    const pending = await handleGithubAppWebhookPending(
      { appId: "1", pem, installationId: "42" },
      "http://localhost:5180",
      owns,
    );
    assert.equal(pending.status, 200);
    const parsed = JSON.parse(pending.body);
    assert.equal(parsed.events.length, 1);
    assert.equal(parsed.events[0].installationId, "42");
    const empty = await handleGithubAppWebhookPending(
      { appId: "1", pem, installationId: "42" },
      "http://localhost:5180",
      owns,
    );
    assert.equal(JSON.parse(empty.body).events.length, 0);
    if (previous === undefined) process.env.GITHUB_WEBHOOK_SECRET = "";
    else process.env.GITHUB_WEBHOOK_SECRET = previous;
  });

  it("refuses pending drain without an allowlisted Origin", async () => {
    const { generateKeyPairSync } = await import("node:crypto");
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const pem = privateKey.export({ type: "pkcs8", format: "pem" });
    const denied = await handleGithubAppWebhookPending(
      { appId: "1", pem, installationId: "42" },
      "",
    );
    assert.equal(denied.status, 403);
  });
});

describe("git backup put proxy", () => {
  it("writes ciphertext to GitLab files API", async () => {
    const calls = [];
    const fetchImpl = async (url, init) => {
      calls.push({ url: String(url), method: init?.method ?? "GET" });
      if (String(url).includes("/repository/files/") && !init?.method) {
        return { ok: false, status: 404, text: async () => "{}" };
      }
      if ((init?.method ?? "") === "POST" || (init?.method ?? "") === "PUT") {
        return {
          ok: true,
          status: 201,
          text: async () => JSON.stringify({ commit_id: "gl-sha" }),
        };
      }
      return { ok: false, status: 404, text: async () => "{}" };
    };
    const outcome = await handleGitBackupPut(
      {
        forge: "gitlab",
        token: "glpat-x",
        owner: "acme",
        repo: "vault",
        contentBase64: Buffer.from("{}").toString("base64"),
      },
      "http://localhost:5180",
      fetchImpl,
    );
    assert.equal(outcome.status, 200);
    assert.equal(JSON.parse(outcome.body).commitSha, "gl-sha");
    assert.ok(calls.some((c) => c.url.includes("gitlab.com")));
  });

  it("writes ciphertext to Codeberg contents API", async () => {
    const fetchImpl = async (url, init) => {
      if ((init?.method ?? "GET") === "GET") {
        return { ok: false, status: 404, text: async () => "{}" };
      }
      return {
        ok: true,
        status: 201,
        text: async () =>
          JSON.stringify({ commit: { sha: "cb-sha" }, content: { sha: "b" } }),
      };
    };
    const outcome = await handleGitBackupPut(
      {
        forge: "codeberg",
        token: "tok",
        owner: "acme",
        repo: "vault",
        contentBase64: Buffer.from("{}").toString("base64"),
      },
      "http://localhost:5180",
      fetchImpl,
    );
    assert.equal(outcome.status, 200);
    assert.equal(JSON.parse(outcome.body).commitSha, "cb-sha");
  });
});
