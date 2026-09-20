import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  handleGithubAppCallback,
  handleGithubAppConvert,
  handleGithubAppConvertOptions,
  handleGithubAppInstallations,
} from "../github-app.mjs";

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
