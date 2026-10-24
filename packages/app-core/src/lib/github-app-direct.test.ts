import { afterEach, expect, it } from "vitest";
import {
  convertGithubAppManifest,
  createGithubInstallationToken,
  githubApiJson,
  listGithubAppInstallations,
  readGithubApp,
} from "./github-app-direct.js";
import {
  credentials,
  githubFixture,
  tokenReply,
} from "./github-app-direct.test-support.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()?.();
});

it("converts a manifest without authentication, then authenticates app reads using only a local assertion", async () => {
  const fixture = await githubFixture((request, response) =>
    response.end(
      JSON.stringify(
        request.path.includes("conversions")
          ? {
              id: 12,
              slug: "test",
              name: "Test",
              client_id: "Iv1.test",
              client_secret: "conversion-secret",
              pem: credentials.privateKey,
            }
          : { id: 12, slug: "test", name: "Test" },
      ),
    ),
  );
  cleanups.push(fixture.close);
  expect(
    (await convertGithubAppManifest(fixture.transport, "one-time-code"))
      .client_id,
  ).toBe("Iv1.test");
  expect((await readGithubApp(fixture.transport, credentials)).id).toBe(12);
  expect(fixture.requests[0]).toMatchObject({
    path: "/app-manifests/one-time-code/conversions",
    method: "POST",
  });
  expect(fixture.requests[0]?.headers.authorization).toBeUndefined();
  expect(fixture.requests[1]?.headers.authorization).toMatch(/^Bearer ey/);
  expect(JSON.stringify(fixture.requests)).not.toContain("PRIVATE KEY");
  expect(JSON.stringify(fixture.requests)).not.toContain("conversion-secret");
});

it("attenuates an installation token to one repository and the Contents access its step needs", async () => {
  const fixture = await githubFixture((_request, response) =>
    tokenReply(response),
  );
  cleanups.push(fixture.close);
  for (const access of ["read", "write"] as const)
    expect(
      await createGithubInstallationToken(
        fixture.transport,
        credentials,
        77,
        "encrypted-vault",
        access,
      ),
    ).toBe("ghs_fixture_ephemeral");
  expect(fixture.requests.map((request) => request.path)).toEqual([
    "/app/installations/77/access_tokens",
    "/app/installations/77/access_tokens",
  ]);
  expect(
    fixture.requests.map((request) => JSON.parse(request.body ?? "")),
  ).toEqual([
    {
      repositories: ["encrypted-vault"],
      permissions: { contents: "read", metadata: "read" },
    },
    {
      repositories: ["encrypted-vault"],
      permissions: { contents: "write", metadata: "read" },
    },
  ]);
  await expect(
    createGithubInstallationToken(fixture.transport, credentials, 77, "", "read"),
  ).rejects.toThrow("repository");
  expect(fixture.requests).toHaveLength(2);
});

it("paginates installations on the fixed API, ignoring foreign Link headers", async () => {
  const row = {
    id: 7,
    account: { login: "owner", type: "Organization" },
    repository_selection: "selected",
  };
  const fixture = await githubFixture((request, response) => {
    response.setHeader("Link", '<https://foreign.invalid/steal>; rel="next"');
    response.end(
      JSON.stringify(
        request.path.endsWith("page=1")
          ? Array.from({ length: 100 }, () => row)
          : [],
      ),
    );
  });
  cleanups.push(fixture.close);
  const installations = await listGithubAppInstallations(
    fixture.transport,
    credentials,
  );
  expect(installations).toHaveLength(100);
  expect(installations[0]?.account.type).toBe("Organization");
  expect(fixture.requests.map((request) => request.path)).toEqual([
    "/app/installations?per_page=100&page=1",
    "/app/installations?per_page=100&page=2",
  ]);
});

it.each([401, 403, 500])(
  "refuses HTTP %i without echoing provider bodies",
  async (status) => {
    const fixture = await githubFixture((_request, response) => {
      response.writeHead(status);
      response.end("provider reflected credential-secret");
    });
    cleanups.push(fixture.close);
    await expect(readGithubApp(fixture.transport, credentials)).rejects.toThrow(
      "GitHub did not authorize or complete",
    );
  },
);

it("cancels a streaming response and refuses a revoked vault before dispatch", async () => {
  let sent: () => void = () => {};
  const started = new Promise<void>((resolve) => {
    sent = resolve;
  });
  const fixture = await githubFixture((_request, response) => {
    response.write('{"id":');
    sent();
  });
  cleanups.push(fixture.close);
  const pending = readGithubApp(fixture.transport, credentials);
  await started;
  fixture.lifetime.abort();
  await expect(pending).rejects.toThrow("cancelled");
  const revoked = await githubFixture((_request, response) =>
    response.end("{}"),
  );
  cleanups.push(revoked.close);
  revoked.revoke();
  await expect(readGithubApp(revoked.transport, credentials)).rejects.toThrow(
    "no longer current",
  );
  expect(revoked.requests).toHaveLength(0);
});

it("rejects oversized and malformed data and invalid API paths", async () => {
  const fixture = await githubFixture((request, response) =>
    response.end(
      request.path === "/large" ? "x".repeat(1024 * 1024 + 1) : "not-json",
    ),
  );
  cleanups.push(fixture.close);
  await expect(
    githubApiJson(fixture.transport, "/large", { method: "GET" }),
  ).rejects.toThrow("too much data");
  await expect(
    githubApiJson(fixture.transport, "/malformed", { method: "GET" }),
  ).rejects.toThrow("unreadable");
  await expect(
    githubApiJson(fixture.transport, "//foreign.invalid", { method: "GET" }),
  ).rejects.toThrow("path");
  expect(fixture.requests).toHaveLength(2);
});

it("rechecks the captured session after serializing a request body", async () => {
  const fixture = await githubFixture((_request, response) =>
    response.end("{}"),
  );
  cleanups.push(fixture.close);
  const body = {
    get target() {
      fixture.revoke();
      return "backups";
    },
  };
  await expect(
    githubApiJson(fixture.transport, "/app", { method: "POST", body }),
  ).rejects.toThrow("no longer current");
  expect(fixture.requests).toHaveLength(0);
});

it("rechecks token custody after the HTTP helper resolves", async () => {
  let current = true;
  let readComplete = false;
  let checksAfterRead = 0;
  const transport = {
    signal: new AbortController().signal,
    assertCurrent() {
      if (!current) throw new Error("Captured token custody ended");
      if (readComplete && ++checksAfterRead === 1)
        queueMicrotask(() => {
          current = false;
        });
    },
    async fetch() {
      const response = Response.json({
        token: "ephemeral-secret",
        expires_at: new Date(Date.now() + 3600000).toISOString(),
      });
      const stream = response.body;
      if (!stream) throw new Error("Missing fixture response body");
      const getReader = stream.getReader.bind(stream);
      Object.defineProperty(stream, "getReader", {
        value: () => {
          const reader = getReader();
          const release = reader.releaseLock.bind(reader);
          reader.releaseLock = () => {
            release();
            readComplete = true;
          };
          return reader;
        },
      });
      return response;
    },
  };
  await expect(
    createGithubInstallationToken(transport, credentials, 77, "backups", "write"),
  ).rejects.toThrow("custody ended");
});
