/** Upload only a locally encrypted vault envelope through GitHub's Contents API. */
import {
  parseOfflineBackupEnvelope,
  serializeOfflineBackupEnvelope,
} from "@opensesame/vault-core";
import { z } from "zod";
import {
  type GithubAppCredentials,
  type GithubDirectTransport,
  createGithubInstallationToken,
  githubApiJson,
  githubRepositoryName,
} from "./github-app-direct.js";
import {
  GithubDirectError,
  assertGithubCurrent,
} from "./github-app-signing.js";
import { bytesToBase64 } from "./native-base64.js";

export type GithubBackupTarget = {
  installationId: number;
  owner: string;
  repo: string;
  branch: string;
};
const sha = z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/);
type GithubBackupWrite = {
  message: string;
  branch: string;
  content: string;
  sha?: string;
};
export type GithubBackupCommit = { commitSha: string };

function contentsPath(target: GithubBackupTarget): string {
  if (
    !/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/.test(target.owner) ||
    !target.branch ||
    target.branch.length > 255 ||
    !/^[\x21-\x7e]+$/.test(target.branch)
  )
    throw new GithubDirectError(
      "configuration",
      "Enter a valid GitHub owner and branch.",
    );
  return `/repos/${encodeURIComponent(target.owner)}/${encodeURIComponent(githubRepositoryName(target.repo))}/contents/opensesame-vault.backup.json`;
}

export async function putGithubAppBackup(
  transport: GithubDirectTransport,
  credentials: GithubAppCredentials,
  target: GithubBackupTarget,
  encryptedEnvelopeJson: string,
): Promise<GithubBackupCommit> {
  assertGithubCurrent(transport);
  const path = contentsPath(target);
  // Canonicalize via the ciphertext envelope parser: never forward extra caller fields.
  const ciphertext = serializeOfflineBackupEnvelope(
    parseOfflineBackupEnvelope(encryptedEnvelopeJson),
  );
  const token = await createGithubInstallationToken(
    transport,
    credentials,
    target.installationId,
    target.repo,
  );
  const existing = await githubApiJson(
    transport,
    `${path}?ref=${encodeURIComponent(target.branch)}`,
    { method: "GET", token },
    true,
  );
  const prior =
    existing === null
      ? null
      : z.object({ sha, type: z.literal("file") }).safeParse(existing);
  if (prior && !prior.success)
    throw new GithubDirectError(
      "response",
      "GitHub returned an unexpected backup file.",
    );
  assertGithubCurrent(transport);
  const body: GithubBackupWrite = {
    message: "Back up encrypted OpenSesame vault",
    branch: target.branch,
    content: bytesToBase64(new TextEncoder().encode(ciphertext)),
  };
  if (prior?.success) body.sha = prior.data.sha;
  const result = await githubApiJson(transport, path, {
    method: "PUT",
    token,
    body,
  });
  const saved = z.object({ commit: z.object({ sha }) }).safeParse(result);
  if (!saved.success)
    throw new GithubDirectError(
      "response",
      "GitHub did not confirm the backup commit.",
    );
  assertGithubCurrent(transport);
  return { commitSha: saved.data.commit.sha };
}
