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
import { base64ToBytes, bytesToBase64 } from "./native-base64.js";

export type GithubBackupTarget = {
  installationId: number;
  owner: string;
  repo: string;
  branch: string;
};
const MAX_BYTES = 512 * 1024;
const sha = z
  .string()
  .regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/)
  .refine((value) => !/^0+$/.test(value));
type GithubBackupWrite = {
  message: string;
  branch: string;
  content: string;
  sha?: string;
};
export type GithubBackupCommit = { commitSha: string };
const backupFile = z.object({
  type: z.literal("file"),
  path: z.literal("opensesame-vault.backup.json"),
  sha,
  encoding: z.literal("base64"),
  size: z.number().int().min(1).max(MAX_BYTES),
  content: z.string().max(750000),
});

function ciphertext(text: string): string {
  if (new TextEncoder().encode(text).length > MAX_BYTES)
    throw new GithubDirectError(
      "configuration",
      "The encrypted GitHub backup is too large.",
    );
  return serializeOfflineBackupEnvelope(parseOfflineBackupEnvelope(text));
}

async function readCiphertext(
  transport: GithubDirectTransport,
  path: string,
  token: string,
  revision: string,
): Promise<string> {
  const parsed = backupFile.safeParse(
    await githubApiJson(
      transport,
      `${path}?ref=${encodeURIComponent(revision)}`,
      { method: "GET", token },
    ),
  );
  if (!parsed.success)
    throw new GithubDirectError(
      "response",
      "GitHub returned an unexpected backup file.",
    );
  try {
    const encoded = parsed.data.content.replaceAll("\n", "");
    const bytes = base64ToBytes(encoded);
    if (bytes.length !== parsed.data.size || bytesToBase64(bytes) !== encoded)
      throw new Error("Invalid backup encoding");
    const blob = new Uint8Array([
      ...new TextEncoder().encode(`blob ${bytes.length}\0`),
      ...bytes,
    ]);
    const digest = new Uint8Array(
      await crypto.subtle.digest(
        parsed.data.sha.length === 64 ? "SHA-256" : "SHA-1",
        blob,
      ),
    );
    assertGithubCurrent(transport);
    const actual = Array.from(digest, (byte) =>
      byte.toString(16).padStart(2, "0"),
    ).join("");
    if (actual !== parsed.data.sha) throw new Error("Invalid backup digest");
    return ciphertext(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    assertGithubCurrent(transport);
    throw new GithubDirectError(
      "response",
      "GitHub did not preserve the encrypted backup.",
    );
  }
}

/** Return the actual encrypted envelope from one immutable branch commit. */
export async function readGithubAppBackup(
  transport: GithubDirectTransport,
  credentials: GithubAppCredentials,
  target: GithubBackupTarget,
): Promise<string> {
  assertGithubCurrent(transport);
  const path = contentsPath(target);
  const token = await createGithubInstallationToken(
    transport,
    credentials,
    target.installationId,
    target.repo,
  );
  const reference = z
    .object({
      ref: z.string(),
      object: z.object({ type: z.literal("commit"), sha }),
    })
    .safeParse(
      await githubApiJson(
        transport,
        `/repos/${encodeURIComponent(target.owner)}/${encodeURIComponent(target.repo)}/git/ref/heads/${target.branch.split("/").map(encodeURIComponent).join("/")}`,
        { method: "GET", token },
      ),
    );
  if (
    !reference.success ||
    reference.data.ref !== `refs/heads/${target.branch}`
  )
    throw new GithubDirectError(
      "response",
      "GitHub did not identify the backup branch.",
    );
  return readCiphertext(transport, path, token, reference.data.object.sha);
}

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
  const encrypted = ciphertext(encryptedEnvelopeJson);
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
    content: bytesToBase64(new TextEncoder().encode(encrypted)),
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
  const recovered = await readCiphertext(
    transport,
    path,
    token,
    saved.data.commit.sha,
  );
  if (recovered !== encrypted)
    throw new GithubDirectError(
      "response",
      "GitHub did not preserve the encrypted backup.",
    );
  assertGithubCurrent(transport);
  return { commitSha: saved.data.commit.sha };
}
