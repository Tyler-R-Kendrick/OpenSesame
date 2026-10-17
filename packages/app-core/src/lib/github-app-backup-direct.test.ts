import {
  buildOfflineBackupEnvelope,
  createVault,
  openJson,
  parseOfflineBackupEnvelope,
  sealJson,
  serializeOfflineBackupEnvelope,
} from "@opensesame/vault-core";
import { afterEach, beforeAll, expect, it } from "vitest";
import { z } from "zod";
import { putGithubAppBackup } from "./github-app-backup-direct.js";
import {
  credentials,
  githubFixture,
  tokenReply,
} from "./github-app-direct.test-support.js";

const target = {
  owner: "fixture-owner",
  repo: "backups",
  branch: "backup/primary",
  installationId: 77,
};
const cleanups: (() => Promise<void>)[] = [];
let envelopeJson = "";
type TestNote = { note: string };
let decrypt: (text: string) => Promise<TestNote>;
beforeAll(async () => {
  const vault = await createVault("test-only-master-password");
  vault.rawVaultKey.fill(0);
  const body = await sealJson(vault.vaultKey, {
    note: "private note that must stay encrypted",
  });
  envelopeJson = serializeOfflineBackupEnvelope(
    buildOfflineBackupEnvelope({ header: vault.header, body }),
  );
  decrypt = (text) =>
    openJson<TestNote>(
      vault.vaultKey,
      parseOfflineBackupEnvelope(text).vault.body,
    );
});
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()?.();
});

it.each([false, true])(
  "writes ciphertext only, with the existing SHA exactly when updating (%s)",
  async (exists) => {
    const fixture = await githubFixture((request, response) => {
      if (request.path.includes("access_tokens")) return tokenReply(response);
      if (request.method === "GET") {
        response.writeHead(exists ? 200 : 404);
        response.end(JSON.stringify({ sha: "a".repeat(40), type: "file" }));
        return;
      }
      response.writeHead(exists ? 200 : 201);
      response.end(JSON.stringify({ commit: { sha: "b".repeat(40) } }));
    });
    cleanups.push(fixture.close);
    expect(
      await putGithubAppBackup(
        fixture.transport,
        credentials,
        target,
        envelopeJson,
      ),
    ).toEqual({ commitSha: "b".repeat(40) });
    expect(fixture.requests.map((request) => request.method)).toEqual([
      "POST",
      "GET",
      "PUT",
    ]);
    expect(fixture.requests[1]?.path).toBe(
      "/repos/fixture-owner/backups/contents/opensesame-vault.backup.json?ref=backup%2Fprimary",
    );
    const uploaded = z
      .object({
        branch: z.string(),
        content: z.string(),
        sha: z.string().optional(),
      })
      .parse(JSON.parse(fixture.requests[2]?.body ?? ""));
    expect(uploaded.branch).toBe("backup/primary");
    expect(uploaded.sha).toBe(exists ? "a".repeat(40) : undefined);
    const recovered = Buffer.from(uploaded.content, "base64").toString("utf8");
    expect(await decrypt(recovered)).toEqual({
      note: "private note that must stay encrypted",
    });
    expect(recovered).not.toContain("private note");
    expect(JSON.stringify(fixture.requests)).not.toContain("master-password");
    expect(JSON.stringify(fixture.requests)).not.toContain("PRIVATE KEY");
    expect(fixture.requests[2]?.headers.authorization).toBe(
      "Bearer ghs_fixture_ephemeral",
    );
  },
);

it("refuses plaintext and deployment-sealed input before making any request", async () => {
  const fixture = await githubFixture((_request, response) =>
    response.end("{}"),
  );
  cleanups.push(fixture.close);
  for (const text of [
    '{"password":"do-not-upload"}',
    envelopeJson.replace(
      '"deploymentSealUsed": false',
      '"deploymentSealUsed": true',
    ),
  ])
    await expect(
      putGithubAppBackup(fixture.transport, credentials, target, text),
    ).rejects.toThrow();
  expect(fixture.requests).toHaveLength(0);
});

it("does not overwrite a denied or malformed existing file, or invent success from a missing commit", async () => {
  let mode = "denied";
  const fixture = await githubFixture((request, response) => {
    if (request.path.includes("access_tokens")) return tokenReply(response);
    if (request.method === "GET") {
      response.writeHead(
        mode === "denied" ? 403 : mode === "bad-file" ? 200 : 404,
      );
      response.end("{}");
      return;
    }
    response.end("{}");
  });
  cleanups.push(fixture.close);
  await expect(
    putGithubAppBackup(fixture.transport, credentials, target, envelopeJson),
  ).rejects.toThrow("did not authorize");
  mode = "bad-file";
  await expect(
    putGithubAppBackup(fixture.transport, credentials, target, envelopeJson),
  ).rejects.toThrow("unexpected backup");
  expect(
    fixture.requests.filter((request) => request.method === "PUT"),
  ).toHaveLength(0);
  mode = "missing-commit";
  await expect(
    putGithubAppBackup(fixture.transport, credentials, target, envelopeJson),
  ).rejects.toThrow("confirm the backup");
});

it("stops before Contents dispatch when the captured vault is revoked during token retrieval", async () => {
  const fixture = await githubFixture((_request, response) => {
    fixture.revoke();
    tokenReply(response);
  });
  cleanups.push(fixture.close);
  await expect(
    putGithubAppBackup(fixture.transport, credentials, target, envelopeJson),
  ).rejects.toThrow("no longer current");
  expect(fixture.requests).toHaveLength(1);
});

it("refuses a malformed commit SHA instead of confirming a write", async () => {
  const fixture = await githubFixture((request, response) => {
    if (request.path.includes("access_tokens")) return tokenReply(response);
    if (request.method === "GET") response.writeHead(404);
    response.end(JSON.stringify({ commit: { sha: "a".repeat(41) } }));
  });
  cleanups.push(fixture.close);
  await expect(
    putGithubAppBackup(fixture.transport, credentials, target, envelopeJson),
  ).rejects.toThrow("confirm the backup");
});
