// Release API operations. Immutable product collisions always fail. Fresh
// evidence may replace staging files only in an unpublished, owned draft for
// the identical candidate. A published release never permits asset mutation.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  EVIDENCE_ASSETS,
  productAssets,
  releaseInventory,
} from "./stage-release.mjs";

export class ReleaseApi {
  constructor(repository, token, fetcher = fetch) {
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository))
      throw new Error("Invalid repository");
    this.repository = repository;
    this.token = token;
    this.fetch = fetcher;
  }
  async request(path, { method = "GET", body, optional = false } = {}) {
    const response = await this.fetch(
      `https://api.github.com/repos/${this.repository}/${path}`,
      {
        method,
        headers: {
          Authorization: `Bearer ${this.token}`,
          Accept: "application/vnd.github+json",
          "Content-Type": "application/json",
          "X-GitHub-Api-Version": "2022-11-28",
        },
        body: body ? JSON.stringify(body) : undefined,
        redirect: "error",
        signal: AbortSignal.timeout(60_000),
      },
    );
    if (optional && response.status === 404) return null;
    if (!response.ok)
      throw new Error(`Release API ${method} ${path}: HTTP ${response.status}`);
    return response.status === 204 ? null : response.json();
  }
  async upload(releaseId, name, bytes) {
    const result = await this.fetch(
      `https://uploads.github.com/repos/${this.repository}/releases/${releaseId}/assets?name=${encodeURIComponent(name)}`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.token}`,
          "Content-Type": "application/octet-stream",
        },
        body: bytes,
        redirect: "error",
        signal: AbortSignal.timeout(600_000),
      },
    );
    if (!result.ok)
      throw new Error(`Release asset upload ${name}: HTTP ${result.status}`);
    return result.json();
  }
  async assets(releaseId) {
    const files = [];
    for (let page = 1; ; page++) {
      const values = await this.request(
        `releases/${releaseId}/assets?per_page=100&page=${page}`,
      );
      if (!Array.isArray(values)) throw new Error("Missing release assets");
      files.push(...values);
      if (values.length < 100) return files;
    }
  }
}

export async function tagCommit(api, tag) {
  let ref = await api.request(`git/ref/tags/${tag}`, { optional: true });
  if (!ref) return null;
  let object = ref.object;
  for (let depth = 0; object?.type === "tag" && depth < 16; depth++) {
    ref = await api.request(`git/tags/${object.sha}`);
    object = ref.object;
  }
  if (object?.type !== "commit" || !/^[0-9a-f]{40}$/.test(object.sha))
    throw new Error("Invalid or excessively nested release tag");
  return object.sha;
}

function assertVersionAdvance(latest, version) {
  if (!latest || latest.tag_name === `v${version}`) return;
  const previous = /^v(\d+)\.(\d+)\.(\d+)$/.exec(latest.tag_name ?? "");
  if (!previous)
    throw new Error(
      "Latest release has an unsupported version; refusing a silent rollback",
    );
  const next = version.split(".").map(BigInt);
  const before = previous.slice(1).map(BigInt);
  const difference = next
    .map((value, index) => value - before[index])
    .find((value) => value !== 0n);
  if (difference === undefined || difference < 0n)
    throw new Error(
      "Release version does not advance the current stable release",
    );
}

async function assertSourceVersion(api, manifest) {
  const content = await api.request(
    `contents/Cargo.toml?ref=${manifest.source_sha}`,
  );
  const cargo = Buffer.from(content.content ?? "", "base64").toString("utf8");
  const version = /\[workspace\.package\][^[]*?\nversion\s*=\s*"([^"]+)"/.exec(
    cargo,
  )?.[1];
  if (version !== manifest.version)
    throw new Error("Candidate version differs from source Cargo.toml");
}

export async function assertSource(
  api,
  manifest,
  { tagRequired = false } = {},
) {
  productAssets(manifest.version);
  if (!/^[0-9a-f]{40}$/.test(manifest.source_sha))
    throw new Error("Invalid source SHA");
  const main = await api.request("git/ref/heads/main");
  if (main.object?.type !== "commit" || !/^[0-9a-f]{40}$/.test(main.object.sha))
    throw new Error("Main is not a commit");
  const comparison = await api.request(
    `compare/${manifest.source_sha}...${main.object.sha}`,
  );
  if (comparison.merge_base_commit?.sha !== manifest.source_sha)
    throw new Error("Candidate is no longer contained in main");
  await assertSourceVersion(api, manifest);
  const current = await tagCommit(api, `v${manifest.version}`);
  if ((current && current !== manifest.source_sha) || (tagRequired && !current))
    throw new Error(
      "Release tag moved, is missing or collides with another source",
    );
  assertVersionAdvance(
    await api.request("releases/latest", { optional: true }),
    manifest.version,
  );
  return current;
}

export const ownerMarker = (manifest, digest) =>
  `<!-- opensesame-candidate:${manifest.candidate_id}:${digest} -->`;

export function reconcileAssets(actual, expected, draft) {
  const byName = new Map(expected.map((entry) => [entry.name, entry]));
  const seen = new Set();
  const uploads = [];
  const replacements = [];
  for (const asset of actual) {
    if (seen.has(asset.name) || !byName.has(asset.name))
      throw new Error("Unexpected or duplicate release asset");
    seen.add(asset.name);
    const want = byName.get(asset.name);
    if (
      asset.state === "uploaded" &&
      asset.digest === `sha256:${want.sha256}` &&
      asset.size === want.size
    )
      continue;
    if (!draft || !EVIDENCE_ASSETS.includes(asset.name))
      throw new Error(`Immutable release asset collision: ${asset.name}`);
    replacements.push(asset.id);
    uploads.push(want);
  }
  for (const wanted of expected)
    if (!seen.has(wanted.name)) uploads.push(wanted);
  if (!draft && uploads.length)
    throw new Error("Published release is incomplete");
  return { uploads, replacements };
}

export async function prepareDraft(api, directory, manifest, digest) {
  const expected = releaseInventory(directory, manifest);
  const tag = `v${manifest.version}`;
  const marker = ownerMarker(manifest, digest);
  let release = await api.request(`releases/tags/${tag}`, { optional: true });
  if (
    release &&
    (!release.body?.includes(marker) ||
      release.target_commitish !== manifest.source_sha)
  ) {
    throw new Error(
      "Existing release is not an owned draft for this candidate",
    );
  }
  const existingTag = await assertSource(api, manifest);
  if (!existingTag) {
    // Respect any configured tag ruleset. A denied tag write fails here; the
    // workflow never weakens rules or force-updates a protected tag.
    await api.request("git/refs", {
      method: "POST",
      body: { ref: `refs/tags/${tag}`, sha: manifest.source_sha },
    });
  }
  await assertSource(api, manifest, { tagRequired: true });
  if (!release)
    release = await api.request("releases", {
      method: "POST",
      body: {
        tag_name: tag,
        target_commitish: manifest.source_sha,
        name: tag,
        draft: true,
        prerelease: false,
        generate_release_notes: true,
        body: `${marker}\n\nOpenSesame ${tag}, candidate ${manifest.candidate_id}.\n\nProduction Pages and Linux kits are promoted without rebuilding. Archives named TEST-upstream-override are test-only downloads; never use real provider tokens with them.\n\nVerify SHA256SUMS and original build plus promotion signatures as documented in docs/operators/release-kit.md.`,
      },
    });
  const actual = await api.assets(release.id);
  // Candidate.json is the immutable ownership anchor once any payload exists.
  const candidateAsset = actual.find(
    (asset) => asset.name === "candidate.json",
  );
  if (
    actual.length &&
    (!candidateAsset || candidateAsset.digest !== `sha256:${digest}`)
  )
    throw new Error("Draft candidate identity is absent or differs");
  const { uploads, replacements } = reconcileAssets(
    actual,
    expected,
    release.draft,
  );
  for (const assetId of replacements)
    await api.request(`releases/assets/${assetId}`, { method: "DELETE" });
  // Upload identity first so every recoverable partial draft has an anchor.
  uploads.sort((a, b) =>
    a.name === "candidate.json"
      ? -1
      : b.name === "candidate.json"
        ? 1
        : a.name.localeCompare(b.name),
  );
  for (const entry of uploads)
    await api.upload(
      release.id,
      entry.name,
      readFileSync(join(directory, entry.name)),
    );
  reconcileAssets(await api.assets(release.id), expected, false);
  await assertSource(api, manifest, { tagRequired: true });
  return release;
}

export async function publishDraft(api, directory, manifest, digest) {
  const expected = releaseInventory(directory, manifest);
  const release = await api.request(`releases/tags/v${manifest.version}`);
  if (
    !release.body?.includes(ownerMarker(manifest, digest)) ||
    release.target_commitish !== manifest.source_sha
  )
    throw new Error("Release ownership changed");
  reconcileAssets(await api.assets(release.id), expected, false);
  await assertSource(api, manifest, { tagRequired: true });
  if (release.draft)
    await api.request(`releases/${release.id}`, {
      method: "PATCH",
      body: { draft: false, make_latest: "true" },
    });
  return release;
}
