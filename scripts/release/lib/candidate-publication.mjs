import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { receiptEnvelope, verifyReceipt } from "./candidate-evidence.mjs";
import { envelope } from "./candidate-model.mjs";
import { demand, hash } from "./candidate-policy.mjs";
import { verifyPublishedRelease } from "./candidate-published.mjs";

async function tagCommit(api, tag) {
  demand(/^v\d+\.\d+\.\d+$/.test(tag), "Unsupported stable release tag");
  const ref = await api.get(`/git/ref/tags/${tag}`, { optional: true });
  if (!ref) return null;
  let object = ref.object;
  for (let depth = 0; depth < 5 && object.type === "tag"; depth++) {
    object = (await api.get(`/git/tags/${object.sha}`)).object;
  }
  demand(object?.type === "commit", "Release tag does not resolve to a commit");
  return object.sha;
}

export async function publicationState(
  service,
  candidate,
  manifest,
  directory,
) {
  const tag = `v${manifest.version}`;
  const target = await tagCommit(service.api, tag);
  demand(
    !target || target === candidate.source_sha,
    `Version collision: ${tag} points at another source`,
  );
  const release = await service.api.get(`/releases/tags/${tag}`, {
    optional: true,
  });
  let promote = true;
  if (release) {
    demand(
      !release.prerelease,
      "Stable version is occupied by an incompatible prerelease",
    );
    const matches = release.assets.filter(
      (item) => item.name === "candidate.json",
    );
    demand(matches.length <= 1, "Ambiguous published candidate metadata");
    if (matches.length) {
      const bytes = await service.api.get(`/releases/assets/${matches[0].id}`, {
        binary: true,
      });
      if (release.draft)
        demand(
          hash(bytes) === candidate.payload_digest,
          "Existing draft belongs to a different candidate",
        );
      else {
        await (service.verifyPublished || verifyPublishedRelease)(
          service,
          release,
          manifest,
          bytes,
          directory,
        );
        promote = false;
      }
    } else
      demand(
        release.draft,
        "Published version has no candidate identity; choose a new stable version",
      );
  }
  const stable = (await service.api.pages("/releases")).filter(
    (item) => !item.draft && !item.prerelease,
  );
  for (const previous of stable) {
    const previousSha = await tagCommit(service.api, previous.tag_name);
    demand(
      previousSha &&
        (await service.api.ancestor(previousSha, candidate.source_sha)),
      `Candidate would roll back or diverge from published ${previous.tag_name}`,
    );
  }
  return { tag, version: manifest.version, promote: String(promote) };
}

export async function verifyPromotion(service, raw, directory, refs) {
  demand(
    service.ctx.workflow === ".github/workflows/release-weekly.yml",
    "Only weekly release controller can authorize publication",
  );
  await service.admission("release-weekly");
  const candidate = envelope(raw);
  const verified = await service.verify(candidate, directory);
  const specifications = [
    ["prerelease", { stage: "prerelease" }],
    ["mutation", { stage: "release-qualified", suite: "mutation" }],
    ["security", { stage: "release-qualified", suite: "security" }],
  ];
  const records = {};
  for (const [name, specification] of specifications) {
    const ref = receiptEnvelope(refs[name]);
    demand(
      ref.run_id === service.ctx.runId &&
        ref.run_attempt === service.ctx.runAttempt,
      "Publication requires all qualification gates in the current attempt; rerun all jobs",
    );
    records[name] = await verifyReceipt(service, ref, candidate, specification);
  }
  for (const name of ["mutation", "security"]) {
    demand(
      JSON.stringify(receiptEnvelope(records[name].receipt.prerequisite)) ===
        JSON.stringify(records.prerelease.ref),
      "Deep checks did not follow the selected prerelease qualification",
    );
  }
  const dev = await verifyReceipt(
    service,
    records.prerelease.receipt.prerequisite,
    candidate,
    { stage: "dev", maxAgeHours: 48 },
  );
  const state = await publicationState(
    service,
    candidate,
    verified.manifest,
    directory,
  );
  const evidenceDirectory = resolve(`${directory}-evidence`);
  await mkdir(evidenceDirectory, { recursive: true });
  for (const [name, record] of [...Object.entries(records), ["dev", dev]]) {
    await writeFile(
      resolve(evidenceDirectory, `${name}-receipt.json`),
      `${JSON.stringify(record.receipt)}\n`,
      { flag: "wx" },
    );
  }
  const promotion = {
    format: "opensesame-promotion",
    schema_version: 1,
    repository: service.ctx.repository,
    candidate,
    policy_sha256: await service.policyHash(),
    controller: {
      run_id: service.ctx.runId,
      run_attempt: service.ctx.runAttempt,
      workflow_ref: service.ctx.workflowRef,
      workflow_sha: service.ctx.workflowSha,
    },
    qualifications: Object.fromEntries(
      Object.entries(records).map(([name, record]) => [name, record.ref]),
    ),
  };
  await writeFile(
    resolve(evidenceDirectory, "promotion.json"),
    `${JSON.stringify(promotion)}\n`,
    { flag: "wx" },
  );
  return { ...verified, ...state, evidence_directory: evidenceDirectory };
}
