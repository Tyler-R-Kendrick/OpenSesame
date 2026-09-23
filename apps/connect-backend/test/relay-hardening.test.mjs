import assert from "node:assert/strict";
import { createHmac, generateKeyPairSync } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { isNonPublicAddress } from "../forge-host-guard.mjs";
import { handleGitBackupPut } from "../git-backup-put.mjs";
import {
  clearGithubAppWebhookPending,
  handleGithubAppWebhook,
  handleGithubAppWebhookPending,
} from "../github-app-contents.mjs";

const ORIGIN = "http://localhost:5180";
// Node runs test files in parallel; this file keeps a queue of its own.
process.env.CONNECT_WEBHOOK_QUEUE_PATH = join(
  tmpdir(),
  `opensesame-relay-hardening-${process.pid}.json`,
);

function freshPem() {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  return privateKey.export({ type: "pkcs8", format: "pem" });
}

async function enqueue(installationId, delivery) {
  const body = { installation: { id: installationId } };
  const rawBody = JSON.stringify(body);
  const digest = createHmac("sha256", "test-webhook-secret")
    .update(rawBody)
    .digest("hex");
  const posted = await handleGithubAppWebhook(
    body,
    {
      "x-github-delivery": delivery,
      "x-hub-signature-256": `sha256=${digest}`,
    },
    rawBody,
  );
  assert.equal(posted.status, 204);
}

describe("webhook-pending drain", () => {
  let previousSecret;

  beforeEach(() => {
    clearGithubAppWebhookPending();
    previousSecret = process.env.GITHUB_WEBHOOK_SECRET;
    process.env.GITHUB_WEBHOOK_SECRET = "test-webhook-secret";
  });

  afterEach(() => {
    clearGithubAppWebhookPending();
    if (previousSecret === undefined) process.env.GITHUB_WEBHOOK_SECRET = "";
    else process.env.GITHUB_WEBHOOK_SECRET = previousSecret;
  });

  it("refuses an unrelated key and leaves the victim's queue intact", async () => {
    await enqueue(77, "del-victim");
    const asked = [];
    // GitHub answers 401 for a JWT the App's registered key did not sign.
    const github = async (url, init) => {
      asked.push({ url: String(url), auth: init.headers.Authorization });
      return { status: 401, text: async () => '{"message":"Bad credentials"}' };
    };
    const stolen = await handleGithubAppWebhookPending(
      { appId: "1", pem: freshPem(), installationId: "77" },
      ORIGIN,
      github,
    );
    assert.equal(stolen.status, 401);
    assert.equal(JSON.parse(stolen.body).error, "credentials_invalid");
    assert.equal(asked.length, 1);
    assert.equal(asked[0].url, "https://api.github.com/app/installations/77");
    assert.match(asked[0].auth, /^Bearer /);

    const owner = async () => ({
      status: 200,
      text: async () => JSON.stringify({ id: 77, app_id: 9 }),
    });
    const drained = await handleGithubAppWebhookPending(
      { appId: "9", pem: freshPem(), installationId: "77" },
      ORIGIN,
      owner,
    );
    assert.equal(drained.status, 200);
    assert.equal(JSON.parse(drained.body).events.length, 1);
  });

  it("refuses an installation GitHub says belongs to another App", async () => {
    await enqueue(78, "del-other-app");
    const otherApp = async () => ({
      status: 200,
      text: async () => JSON.stringify({ id: 78, app_id: 2 }),
    });
    const outcome = await handleGithubAppWebhookPending(
      { appId: "1", pem: freshPem(), installationId: "78" },
      ORIGIN,
      otherApp,
    );
    assert.equal(outcome.status, 401);
    const owner = async () => ({
      status: 200,
      text: async () => JSON.stringify({ id: 78, app_id: 2 }),
    });
    const kept = await handleGithubAppWebhookPending(
      { appId: "2", pem: freshPem(), installationId: "78" },
      ORIGIN,
      owner,
    );
    assert.equal(JSON.parse(kept.body).events.length, 1);
  });

  it("refuses when GitHub cannot be asked", async () => {
    const unreachable = async () => {
      throw new Error("offline");
    };
    const outcome = await handleGithubAppWebhookPending(
      { appId: "1", pem: freshPem(), installationId: "79" },
      ORIGIN,
      unreachable,
    );
    assert.equal(outcome.status, 401);
  });
});

const publicDns = async () => [{ address: "93.184.216.34", family: 4 }];

function giteaBody(baseUrl) {
  return {
    forge: "gitea",
    token: "tok",
    owner: "acme",
    repo: "vault",
    baseUrl,
    contentBase64: Buffer.from("{}").toString("base64"),
  };
}

function recordingForge() {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    if ((init.method ?? "GET") === "GET") {
      return { ok: false, status: 404, text: async () => "{}" };
    }
    return {
      ok: true,
      status: 201,
      text: async () => JSON.stringify({ commit: { sha: "gt-sha" } }),
    };
  };
  return { calls, fetchImpl };
}

const REFUSED_BASES = [
  ["https://internal.example/anything?", publicDns],
  ["https://git.example.org/sub/path", publicDns],
  ["https://git.example.org/?x=1", publicDns],
  ["https://git.example.org/#frag", publicDns],
  ["https://user:pw@git.example.org", publicDns],
  ["http://git.example.org", publicDns],
  ["https://127.0.0.1", publicDns],
  ["https://169.254.169.254", publicDns],
  ["https://[::1]", publicDns],
  ["https://[::ffff:10.0.0.1]", publicDns],
  ["https://localhost", publicDns],
  ["https://metadata.google.internal", publicDns],
  ["https://rebind.example", async () => [{ address: "10.0.0.7", family: 4 }]],
  [
    "https://mixed.example",
    async () => [
      { address: "93.184.216.34", family: 4 },
      { address: "fd00::1", family: 6 },
    ],
  ],
  [
    "https://nxdomain.example",
    async () => {
      throw new Error("ENOTFOUND");
    },
  ],
];

describe("git backup put proxy — gitea base URL", () => {
  const previousHosts = process.env.OPENSESAME_GITEA_HOSTS;

  afterEach(() => {
    if (previousHosts === undefined) {
      Reflect.deleteProperty(process.env, "OPENSESAME_GITEA_HOSTS");
    } else process.env.OPENSESAME_GITEA_HOSTS = previousHosts;
  });

  for (const [baseUrl, dns] of REFUSED_BASES) {
    it(`refuses ${baseUrl} without a request`, async () => {
      const { calls, fetchImpl } = recordingForge();
      const outcome = await handleGitBackupPut(
        giteaBody(baseUrl),
        ORIGIN,
        fetchImpl,
        dns,
      );
      assert.equal(outcome.status, 400);
      assert.equal(JSON.parse(outcome.body).error, "gitea_base_url_refused");
      assert.equal(calls.length, 0);
    });
  }

  it("writes to a public Gitea origin and never follows a redirect", async () => {
    const { calls, fetchImpl } = recordingForge();
    const outcome = await handleGitBackupPut(
      giteaBody("https://git.example.org:3000/"),
      ORIGIN,
      fetchImpl,
      publicDns,
    );
    assert.equal(outcome.status, 200);
    assert.equal(JSON.parse(outcome.body).commitSha, "gt-sha");
    assert.equal(calls.length, 2);
    for (const call of calls) {
      assert.ok(
        call.url.startsWith(
          "https://git.example.org:3000/api/v1/repos/acme/vault/contents/",
        ),
      );
      assert.equal(call.init.redirect, "error");
    }
  });
});

describe("git backup put proxy — pinned hosts and Origin", () => {
  const previousHosts = process.env.OPENSESAME_GITEA_HOSTS;

  afterEach(() => {
    if (previousHosts === undefined) {
      Reflect.deleteProperty(process.env, "OPENSESAME_GITEA_HOSTS");
    } else process.env.OPENSESAME_GITEA_HOSTS = previousHosts;
  });

  it("accepts only the operator's pinned hosts when they are listed", async () => {
    process.env.OPENSESAME_GITEA_HOSTS = "git.corp.example";
    const { calls, fetchImpl } = recordingForge();
    const refused = await handleGitBackupPut(
      giteaBody("https://git.example.org"),
      ORIGIN,
      fetchImpl,
      publicDns,
    );
    assert.equal(refused.status, 400);
    const pinned = await handleGitBackupPut(
      giteaBody("https://git.corp.example"),
      ORIGIN,
      fetchImpl,
      async () => [{ address: "10.1.1.1", family: 4 }],
    );
    assert.equal(pinned.status, 200);
    assert.ok(
      calls.every((call) => call.url.startsWith("https://git.corp.example/")),
    );
  });

  it("still asks for a base URL when none is given", async () => {
    const { fetchImpl } = recordingForge();
    const outcome = await handleGitBackupPut(giteaBody(""), ORIGIN, fetchImpl);
    assert.equal(JSON.parse(outcome.body).error, "gitea_base_url_required");
  });

  it("refuses a request with no Origin", async () => {
    const { calls, fetchImpl } = recordingForge();
    const outcome = await handleGitBackupPut(
      giteaBody("https://git.example.org"),
      "",
      fetchImpl,
      publicDns,
    );
    assert.equal(outcome.status, 403);
    assert.equal(calls.length, 0);
  });

  it("classifies addresses", () => {
    for (const address of [
      "10.0.0.1",
      "100.64.1.1",
      "fe80::1",
      "64:ff9b::a9fe:a9fe",
    ]) {
      assert.equal(isNonPublicAddress(address), true, address);
    }
    for (const address of ["93.184.216.34", "2606:4700::1111"]) {
      assert.equal(isNonPublicAddress(address), false, address);
    }
  });
});
