import { createHash, verify } from "node:crypto";
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
import {
  putGithubAppBackup,
  readGithubAppBackup,
} from "./github-app-backup-direct.js";
import {
  credentials,
  githubFixture,
  keyPair,
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
let otherJson = "";
type TestNote = { note: string };
let decrypt: (text: string) => Promise<TestNote>;
beforeAll(async () => {
  const vault = await createVault("test-only-master-password");
  vault.rawVaultKey.fill(0);
  const snapshot = async (note: string) =>
    serializeOfflineBackupEnvelope(
      buildOfflineBackupEnvelope({
        header: vault.header,
        body: await sealJson(vault.vaultKey, { note }),
      }),
    );
  envelopeJson = await snapshot("private note that must stay encrypted");
  otherJson = await snapshot("a different real encrypted note");
  decrypt = (text) =>
    openJson<TestNote>(
      vault.vaultKey,
      parseOfflineBackupEnvelope(text).vault.body,
    );
});
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()?.();
});

function fileReply(text = envelopeJson, algorithm: "sha1" | "sha256" = "sha1") {
  const bytes = Buffer.from(text);
  return {
    type: "file",
    path: "opensesame-vault.backup.json",
    sha: createHash(algorithm)
      .update(`blob ${bytes.length}\0`)
      .update(bytes)
      .digest("hex"),
    size: bytes.length,
    encoding: "base64",
    content: bytes.toString("base64"),
  };
}

function refReply(sha: string) {
  return { ref: "refs/heads/backup/primary", object: { type: "commit", sha } };
}

it.each([false, true])(
  "writes ciphertext only, with the existing SHA exactly when updating (%s)",
  async (exists) => {
    const fixture = await githubFixture((request, response) => {
      if (request.path.includes("access_tokens")) return tokenReply(response);
      if (
        request.method === "GET" &&
        request.path.endsWith(`ref=${"b".repeat(40)}`)
      ) {
        response.end(JSON.stringify(fileReply()));
        return;
      }
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
      "GET",
    ]);
    const assertion = fixture.requests[0]?.headers.authorization
      ?.slice(7)
      .split(".");
    if (!assertion || assertion.length !== 3)
      throw new Error("Missing signed App assertion");
    expect(
      verify(
        "RSA-SHA256",
        Buffer.from(`${assertion[0]}.${assertion[1]}`),
        keyPair.publicKey,
        Buffer.from(assertion[2] ?? "", "base64url"),
      ),
    ).toBe(true);
    expect(JSON.parse(fixture.requests[0]?.body ?? "{}")).toEqual({
      repositories: [target.repo],
      permissions: { contents: "write", metadata: "read" },
    });
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

it.each(["content", "envelope", "digest", "size", "encoding", "path"])(
  "refuses a commit whose immutable readback has wrong %s",
  async (mode) => {
    const fixture = await githubFixture((request, response) => {
      if (request.path.includes("access_tokens")) return tokenReply(response);
      if (request.method === "PUT") {
        response.end(JSON.stringify({ commit: { sha: "b".repeat(40) } }));
        return;
      }
      if (!request.path.endsWith(`ref=${"b".repeat(40)}`)) {
        response.writeHead(404);
        response.end("{}");
        return;
      }
      const file = fileReply(mode === "envelope" ? otherJson : envelopeJson);
      if (mode === "content")
        file.content = Buffer.from("plaintext").toString("base64");
      if (mode === "digest") file.sha = "c".repeat(40);
      if (mode === "size") file.size += 1;
      if (mode === "encoding") file.content = `${file.content} `;
      if (mode === "path") file.path = "another-file.json";
      response.end(JSON.stringify(file));
    });
    cleanups.push(fixture.close);
    await expect(
      putGithubAppBackup(fixture.transport, credentials, target, envelopeJson),
    ).rejects.toThrow();
    expect(fixture.requests.at(-1)?.path).toContain(`ref=${"b".repeat(40)}`);
  },
);

it("reads the actual encrypted file at the resolved commit for restore", async () => {
  const fixture = await githubFixture((request, response) => {
    if (request.path.includes("access_tokens")) return tokenReply(response);
    if (request.path.includes("/git/ref/heads/")) {
      response.end(JSON.stringify(refReply("d".repeat(40))));
      return;
    }
    response.end(JSON.stringify(fileReply()));
  });
  cleanups.push(fixture.close);
  const recovered = await readGithubAppBackup(
    fixture.transport,
    credentials,
    target,
  );
  expect(await decrypt(recovered)).toEqual({
    note: "private note that must stay encrypted",
  });
  expect(fixture.requests.at(-1)?.path).toContain(`ref=${"d".repeat(40)}`);
  expect(JSON.stringify(fixture.requests)).not.toContain("PRIVATE KEY");
});

it("keeps immutable readback owned by the original vault", async () => {
  const fixture = await githubFixture((request, response) => {
    if (request.path.includes("access_tokens")) return tokenReply(response);
    if (request.method === "PUT") {
      response.end(JSON.stringify({ commit: { sha: "b".repeat(40) } }));
      return;
    }
    if (request.path.endsWith(`ref=${"b".repeat(40)}`)) {
      fixture.revoke();
      response.end(JSON.stringify(fileReply()));
      return;
    }
    response.writeHead(404);
    response.end("{}");
  });
  cleanups.push(fixture.close);
  await expect(
    putGithubAppBackup(fixture.transport, credentials, target, envelopeJson),
  ).rejects.toThrow("no longer current");
});

it.each([40, 64])(
  "writes and reads an immutable backup with %i-character object IDs",
  async (length) => {
    const commit = "b".repeat(length);
    const fixture = await githubFixture((request, response) => {
      if (request.path.includes("access_tokens")) return tokenReply(response);
      if (request.path.includes("/git/ref/heads/")) {
        response.end(JSON.stringify(refReply(commit)));
        return;
      }
      if (request.method === "PUT") {
        response.end(JSON.stringify({ commit: { sha: commit } }));
        return;
      }
      if (request.path.endsWith("ref=backup%2Fprimary")) {
        response.writeHead(404);
        response.end("{}");
        return;
      }
      response.end(
        JSON.stringify(
          fileReply(envelopeJson, length === 64 ? "sha256" : "sha1"),
        ),
      );
    });
    cleanups.push(fixture.close);
    await expect(
      putGithubAppBackup(fixture.transport, credentials, target, envelopeJson),
    ).resolves.toEqual({ commitSha: commit });
    const recovered = await readGithubAppBackup(
      fixture.transport,
      credentials,
      target,
    );
    expect(await decrypt(recovered)).toEqual({
      note: "private note that must stay encrypted",
    });
    expect(
      fixture.requests.filter((request) =>
        request.path.endsWith(`ref=${commit}`),
      ),
    ).toHaveLength(2);
  },
);

it.each([40, 64])(
  "refuses all-zero %i-character IDs at prior/write/file/ref boundaries",
  async (length) => {
    for (const stage of ["prior", "write", "file", "ref"]) {
      const commit = "b".repeat(length);
      const fixture = await githubFixture((request, response) => {
        if (request.path.includes("access_tokens")) return tokenReply(response);
        if (request.path.includes("/git/ref/heads/")) {
          response.end(JSON.stringify(refReply("0".repeat(length))));
          return;
        }
        if (request.method === "PUT") {
          response.end(
            JSON.stringify({
              commit: { sha: stage === "write" ? "0".repeat(length) : commit },
            }),
          );
          return;
        }
        if (request.path.endsWith("ref=backup%2Fprimary")) {
          response.writeHead(stage === "prior" ? 200 : 404);
          response.end(
            JSON.stringify({ type: "file", sha: "0".repeat(length) }),
          );
          return;
        }
        response.end(
          JSON.stringify({
            ...fileReply(envelopeJson, length === 64 ? "sha256" : "sha1"),
            sha: "0".repeat(length),
          }),
        );
      });
      cleanups.push(fixture.close);
      const operation =
        stage === "ref"
          ? readGithubAppBackup(fixture.transport, credentials, target)
          : putGithubAppBackup(
              fixture.transport,
              credentials,
              target,
              envelopeJson,
            );
      await expect(operation, stage).rejects.toThrow();
      if (stage === "prior" || stage === "ref")
        expect(
          fixture.requests.some((request) => request.method === "PUT"),
          stage,
        ).toBe(false);
      if (stage === "write")
        expect(
          fixture.requests.some((request) =>
            request.path.endsWith(`ref=${"0".repeat(length)}`),
          ),
        ).toBe(false);
    }
  },
);
