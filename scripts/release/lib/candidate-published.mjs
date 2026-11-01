import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import {
  verifyCandidateProvenance,
  verifyPromotionProvenance,
} from "../provenance.mjs";
import { EVIDENCE_ASSETS, productAssets } from "../stage-release.mjs";
import { verifySite } from "../verify-site.mjs";
import { envelope, validateManifest } from "./candidate-model.mjs";
import { ROOT, demand, digest, hash } from "./candidate-policy.mjs";

export function samePublishedPayload(published, selected) {
  validateManifest(published, {
    source_sha: selected.source_sha,
    candidate_id: published.candidate_id,
    run_id: String(published.producer?.run_id),
    run_attempt: String(published.producer?.run_attempt),
  });
  const payloads = (manifest) =>
    manifest.payloads
      .map((item) => ({
        path: item.path,
        role: item.role,
        target: item.target,
        sha256: item.sha256,
        size: item.size,
      }))
      .sort((a, b) => a.path.localeCompare(b.path));
  demand(
    published.source_sha === selected.source_sha &&
      published.version === selected.version &&
      JSON.stringify(payloads(published)) ===
        JSON.stringify(payloads(selected)),
    "Published version has different source or production/test payload bytes",
  );
}

export function publishedInventory(assets, sums, manifest) {
  const expected = [
    ...productAssets(manifest.version),
    ...EVIDENCE_ASSETS,
  ].sort();
  const names = assets.map((item) => item.name).sort();
  demand(
    JSON.stringify(names) === JSON.stringify(expected),
    "Published release asset inventory is incomplete or unexpected",
  );
  const entries = new Map();
  for (const line of sums.trimEnd().split("\n")) {
    const match = /^([a-f0-9]{64}) {2}([A-Za-z0-9_.-]+)$/.exec(line);
    demand(
      match && !entries.has(match[2]),
      "Published checksum inventory is malformed",
    );
    entries.set(match[2], match[1]);
  }
  demand(
    JSON.stringify([...entries.keys()].sort()) ===
      JSON.stringify(expected.filter((name) => name !== "SHA256SUMS")),
    "Published checksum inventory is incomplete",
  );
  entries.set("SHA256SUMS", hash(sums));
  for (const asset of assets) {
    demand(
      asset.state === "uploaded" &&
        digest(asset.digest) === entries.get(asset.name),
      `Published asset integrity mismatch: ${asset.name}`,
    );
  }
  for (const payload of manifest.payloads) {
    const asset = assets.find((item) => item.name === basename(payload.path));
    demand(
      asset &&
        asset.size === payload.size &&
        entries.get(asset.name) === payload.sha256,
      "Published payload differs from its immutable manifest",
    );
  }
}

export async function verifyPublishedRelease(
  service,
  release,
  selected,
  publishedBytes,
  directory,
) {
  demand(
    !release.draft && !release.prerelease,
    "A draft cannot authorize a published no-op",
  );
  const published = JSON.parse(publishedBytes);
  samePublishedPayload(published, selected);
  demand(
    release.target_commitish === selected.source_sha &&
      release.body?.includes(
        `<!-- opensesame-candidate:${published.candidate_id}:${hash(publishedBytes)} -->`,
      ),
    "Published release ownership or source marker mismatch",
  );
  const metadata = await mkdtemp(join(tmpdir(), "opensesame-published-"));
  const pages = join(metadata, "site");
  try {
    await retainMetadata(service, release, publishedBytes, metadata);
    const sums = await readFile(join(metadata, "SHA256SUMS"), "utf8");
    publishedInventory(release.assets, sums, published);
    const promotion = JSON.parse(
      await readFile(join(metadata, "promotion.json"), "utf8"),
    );
    validatePromotion(
      promotion,
      published,
      publishedBytes,
      service.ctx.repository,
    );
    await verifyPublishedProofs(service, metadata, published, promotion);
    await verifyHostedFiles(selected, directory, pages);
  } finally {
    await rm(metadata, { recursive: true, force: true });
  }
}

async function retainMetadata(service, release, publishedBytes, metadata) {
  for (const name of [
    "candidate.json",
    "promotion.json",
    "SHA256SUMS",
    "build-provenance.sigstore.json",
  ]) {
    const matches = release.assets.filter((item) => item.name === name);
    demand(matches.length === 1, `Published evidence is missing: ${name}`);
    const bytes =
      name === "candidate.json"
        ? publishedBytes
        : await service.api.get(`/releases/assets/${matches[0].id}`, {
            binary: true,
          });
    demand(
      hash(bytes) === digest(matches[0].digest) &&
        bytes.length === matches[0].size,
      "Published metadata bytes mismatch",
    );
    await writeFile(join(metadata, name), bytes);
  }
}

function validatePromotion(promotion, published, publishedBytes, repository) {
  demand(
    promotion.format === "opensesame-promotion" &&
      promotion.schema_version === 1 &&
      promotion.repository === repository,
    "Unknown published promotion schema",
  );
  const promoted = envelope(promotion.candidate);
  demand(
    promoted.candidate_id === published.candidate_id &&
      promoted.source_sha === published.source_sha &&
      promoted.run_id === String(published.producer.run_id) &&
      promoted.run_attempt === String(published.producer.run_attempt) &&
      promoted.payload_digest === hash(publishedBytes),
    "Published promotion does not authorize this candidate",
  );
}

async function verifyPublishedProofs(service, metadata, published, promotion) {
  await verifyCandidateProvenance({
    directory: metadata,
    repository: service.ctx.repository,
    manifest: published,
    token: service.ctx.token,
  });
  await verifyPromotionProvenance({
    directory: metadata,
    repository: service.ctx.repository,
    workflowSha: promotion.controller?.workflow_sha,
    token: service.ctx.token,
  });
}

async function verifyHostedFiles(selected, directory, pages) {
  const archive = selected.payloads.find(
    (item) => item.target === "pages" && item.role === "production",
  );
  demand(
    directory && archive,
    "An exact local candidate is required to verify live Pages",
  );
  execFileSync(
    "python3",
    [
      resolve(ROOT, "scripts/release/archive-safe.py"),
      "tar",
      resolve(directory, archive.path),
      pages,
    ],
    { stdio: "pipe" },
  );
  await verifySite(
    pages,
    "https://opensesame-labs.github.io/OpenSesame/",
    selected.source_sha,
  );
}
