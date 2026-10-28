#!/usr/bin/env node
// Download by immutable artifact ID. An action's warning-only digest check is
// not an acceptance gate: both authenticated API metadata and ZIP bytes must
// match the caller's digest before any member is extracted.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, open, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const api = "https://api.github.com";
const extractor = fileURLToPath(new URL("archive-safe.py", import.meta.url));
const id = (value) => /^[1-9][0-9]*$/.test(String(value));

export function digestHex(value) {
  const hex = String(value ?? "").replace(/^sha256:/, "");
  if (!/^[0-9a-f]{64}$/.test(hex))
    throw new Error("Expected a SHA256 artifact digest");
  return hex;
}

export function assertArtifact(metadata, options) {
  const { artifactId, artifactDigest, runId, runAttempt, expectedName } =
    options;
  if (![artifactId, runId, runAttempt].every(id))
    throw new Error("Invalid artifact/run identity");
  if (
    !expectedName ||
    !/^[A-Za-z0-9_.-]+$/.test(expectedName) ||
    !new RegExp(`(?:^|-)${runId}-${runAttempt}(?:-|$)`).test(expectedName)
  ) {
    throw new Error("Expected artifact name must bind its run and attempt");
  }
  if (
    String(metadata.id) !== String(artifactId) ||
    metadata.name !== expectedName ||
    String(metadata.workflow_run?.id) !== String(runId) ||
    metadata.expired !== false
  ) {
    throw new Error("Artifact identity, origin or expiry mismatch");
  }
  if (digestHex(metadata.digest) !== digestHex(artifactDigest))
    throw new Error("Artifact metadata digest mismatch");
}

export async function githubJson(repository, token, path, fetcher = fetch) {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository))
    throw new Error("Invalid repository");
  const result = await fetcher(`${api}/repos/${repository}/${path}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
    },
    redirect: "error",
    signal: AbortSignal.timeout(60_000),
  });
  if (!result.ok)
    throw new Error(`GitHub artifact request failed: HTTP ${result.status}`);
  return result.json();
}

function signedDownloadUrl(value) {
  const url = new URL(value);
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    ![
      ".blob.core.windows.net",
      ".actions.githubusercontent.com",
      ".githubusercontent.com",
    ].some((suffix) => url.hostname.endsWith(suffix))
  ) {
    throw new Error("Unexpected artifact storage redirect");
  }
  return url;
}

export async function downloadArtifact(options) {
  const {
    repository,
    token,
    artifactId,
    artifactDigest,
    destination,
    fetcher = fetch,
  } = options;
  const metadata = await githubJson(
    repository,
    token,
    `actions/artifacts/${artifactId}`,
    fetcher,
  );
  assertArtifact(metadata, options);
  const redirect = await fetcher(
    `${api}/repos/${repository}/actions/artifacts/${artifactId}/zip`,
    {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
      },
      redirect: "manual",
      signal: AbortSignal.timeout(60_000),
    },
  );
  if (redirect.status !== 302)
    throw new Error(`Artifact archive request failed: HTTP ${redirect.status}`);
  // The GitHub token is never forwarded to storage, even on a redirect.
  const response = await fetcher(
    signedDownloadUrl(redirect.headers.get("location")),
    {
      redirect: "error",
      signal: AbortSignal.timeout(600_000),
    },
  );
  if (!response.ok || !response.body)
    throw new Error(`Artifact storage failed: HTTP ${response.status}`);
  const temporary = await mkdtemp(join(tmpdir(), "opensesame-transfer-"));
  const archive = join(temporary, "artifact.zip");
  try {
    const output = await open(archive, "wx");
    const hash = createHash("sha256");
    let bytes = 0;
    try {
      for await (const chunk of response.body) {
        bytes += chunk.length;
        if (bytes > 8 * 1024 ** 3)
          throw new Error("Artifact download exceeds size limit");
        hash.update(chunk);
        await output.writeFile(chunk);
      }
    } finally {
      await output.close();
    }
    if (hash.digest("hex") !== digestHex(artifactDigest))
      throw new Error("Downloaded artifact digest mismatch");
    execFileSync("python3", [extractor, "zip", archive, destination], {
      stdio: "pipe",
    });
    return metadata;
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

export async function downloadNamedArtifact(options) {
  const { repository, token, runId, expectedName, fetcher = fetch } = options;
  const matches = [];
  for (let page = 1; ; page++) {
    const response = await githubJson(
      repository,
      token,
      `actions/runs/${runId}/artifacts?per_page=100&page=${page}`,
      fetcher,
    );
    if (
      !Array.isArray(response.artifacts) ||
      !Number.isSafeInteger(response.total_count) ||
      response.total_count < 0 ||
      response.total_count > 20_000
    )
      throw new Error("Missing or oversized run artifact inventory");
    matches.push(
      ...response.artifacts.filter(
        (artifact) => artifact.name === expectedName,
      ),
    );
    if (page * 100 >= response.total_count) break;
  }
  if (matches.length !== 1)
    throw new Error(`Expected exactly one artifact named ${expectedName}`);
  const artifact = matches[0];
  return downloadArtifact({
    ...options,
    artifactId: String(artifact.id),
    artifactDigest: artifact.digest,
  });
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const [command, expectedName, destination] = process.argv.slice(2);
  if (command !== "named" || !destination)
    throw new Error("usage: artifact-transfer.mjs named NAME DESTINATION");
  await downloadNamedArtifact({
    repository: process.env.GITHUB_REPOSITORY,
    token: process.env.GH_TOKEN,
    runId: process.env.GITHUB_RUN_ID,
    runAttempt: process.env.GITHUB_RUN_ATTEMPT,
    expectedName,
    destination,
  });
}
