import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertRun, sourceCi } from "./candidate-api.mjs";
import { receiptName, verifyReceipt } from "./candidate-evidence.mjs";
import { envelope } from "./candidate-model.mjs";
import {
  POLICY,
  demand,
  digest,
  hash,
  sha,
  timestamp,
} from "./candidate-policy.mjs";
import { publicationState } from "./candidate-publication.mjs";

export async function newestByAncestry(api, items) {
  demand(items.length > 0, "No eligible candidate evidence exists");
  let newest = items[0];
  for (const item of items.slice(1)) {
    if (item.source_sha === newest.source_sha) continue;
    if (await api.ancestor(newest.source_sha, item.source_sha)) newest = item;
    else
      demand(
        await api.ancestor(item.source_sha, newest.source_sha),
        "Candidate sources have divergent histories",
      );
  }
  return newest;
}

async function recentProducerRuns(service) {
  const cutoff = new Date(
    service.ctx.now - (POLICY.retention_days + 1) * 86400000,
  ).toISOString();
  const runs = [];
  for (const path of POLICY.producers) {
    const file = path.split("/").at(-1);
    runs.push(
      ...(await service.api.pages(
        `/actions/workflows/${file}/runs?branch=main&status=success&created=${encodeURIComponent(`>=${cutoff}`)}`,
        "workflow_runs",
      )),
    );
  }
  return runs.sort((a, b) => timestamp(b.created_at) - timestamp(a.created_at));
}

async function reusableArtifact(service, listed, sourceSha) {
  const artifacts = await service.api.pages(
    `/actions/runs/${listed.id}/artifacts`,
    "artifacts",
  );
  const expectedName = `${sourceSha}-${listed.id}-${listed.run_attempt}-complete`;
  const matches = artifacts.filter(
    (artifact) => artifact.name === expectedName,
  );
  demand(matches.length <= 1, "Ambiguous complete candidate artifact");
  if (!matches.length) return null;
  const artifact = matches[0];
  if (artifact.expired || timestamp(artifact.created_at) > service.ctx.now)
    return null;
  if (
    String(artifact.workflow_run?.id) !== String(listed.id) ||
    artifact.workflow_run?.head_branch !== "main"
  )
    return null;
  return artifact;
}

async function reusableProducer(service, listed) {
  const run = await service.api.attempt(
    String(listed.id),
    String(listed.run_attempt),
  );
  if (
    !POLICY.producers.includes(run.path?.split("@")[0]) ||
    !["schedule", "workflow_dispatch"].includes(run.event)
  )
    return false;
  if (run.status !== "completed" || run.conclusion !== "success") return false;
  assertRun(run, service.ctx, {
    paths: POLICY.producers,
    events: ["schedule", "workflow_dispatch"],
    attempt: listed.run_attempt,
  });
  return service.api.compatiblePolicy(run.head_sha);
}

async function acceptReuse(service, listed, artifact, sourceSha) {
  const directory = await mkdtemp(join(tmpdir(), "opensesame-reuse-"));
  try {
    const metadata = await service.download({
      repository: service.ctx.repository,
      token: service.ctx.token,
      artifactId: String(artifact.id),
      artifactDigest: digest(artifact.digest),
      runId: String(listed.id),
      runAttempt: String(listed.run_attempt),
      destination: directory,
      expectedName: artifact.name,
    });
    const candidate = envelope({
      source_sha: sourceSha,
      candidate_id: artifact.name.slice(0, -"-complete".length),
      run_id: String(listed.id),
      run_attempt: String(listed.run_attempt),
      artifact_id: String(artifact.id),
      artifact_digest: artifact.digest,
      payload_digest: hash(await readFile(join(directory, "candidate.json"))),
    });
    await service.verify(candidate, directory, { downloaded: metadata });
    return candidate;
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function reuseComplete(service, sourceSha) {
  for (const listed of await recentProducerRuns(service)) {
    const artifact = await reusableArtifact(service, listed, sourceSha);
    if (artifact && (await reusableProducer(service, listed))) {
      return acceptReuse(service, listed, artifact, sourceSha);
    }
  }
  return null;
}

export async function selectIntegration(service, { reuse = true } = {}) {
  await service.admission("dev-nightly");
  const main = sha(await service.api.main(), "main selection anchor SHA");
  let selected;
  let cursor = main;
  for (let count = 0; count < POLICY.source_walk_limit && cursor; count++) {
    const runs = await service.api.pages(
      `/actions/workflows/ci.yml/runs?branch=main&event=push&status=success&head_sha=${cursor}`,
      "workflow_runs",
    );
    const eligible = runs.filter(
      (run) => timestamp(run.updated_at) <= service.ctx.now,
    );
    if (eligible.length && (await service.api.compatibleCi(cursor))) {
      const run = eligible[0];
      assertRun(run, service.ctx, {
        paths: [POLICY.ci_path],
        events: ["push"],
        sourceSha: cursor,
        attempt: run.run_attempt,
      });
      selected = {
        source_sha: cursor,
        source_ci_run_id: String(run.id),
        source_ci_run_attempt: String(run.run_attempt),
      };
      await sourceCi(
        service.api,
        cursor,
        selected.source_ci_run_id,
        selected.source_ci_run_attempt,
      );
      break;
    }
    const commit = await service.api.get(`/git/commits/${cursor}`);
    const parents = commit?.parents;
    demand(Array.isArray(parents), "Invalid main history parent list");
    for (const parent of parents) sha(parent?.sha, "main history parent SHA");
    // The first parent follows main's integration history across merge commits.
    // A successful CI run on a merged side branch cannot replace that history.
    cursor = parents[0]?.sha;
  }
  demand(
    selected,
    "No compatible successful CI in the bounded main history; source selection is incomplete",
  );
  const artifact = reuse
    ? await reuseComplete(service, selected.source_sha)
    : null;
  return {
    ...selected,
    ...(artifact || {}),
    reuse: String(Boolean(artifact)),
    selection_cutoff: new Date(service.ctx.now).toISOString(),
    selected_main_sha: main,
    excluded_newer_main: String(main !== selected.source_sha),
  };
}

export async function selectDev(
  service,
  maxAgeHours = POLICY.dev_max_age_hours,
) {
  await service.admission("release-weekly");
  demand(
    maxAgeHours === POLICY.dev_max_age_hours,
    "Dev freshness cannot override current policy",
  );
  const main = await service.api.main();
  const horizon = new Date(
    service.ctx.now -
      (maxAgeHours + POLICY.qualification_max_duration_hours) * 3600000,
  ).toISOString();
  const runs = await service.api.pages(
    `/actions/workflows/dev-nightly.yml/runs?branch=main&status=success&created=${encodeURIComponent(`>=${horizon}`)}`,
    "workflow_runs",
  );
  const candidates = [];
  for (const run of runs) {
    if (
      timestamp(run.updated_at) > service.ctx.now ||
      service.ctx.now - timestamp(run.updated_at) > maxAgeHours * 3600000
    )
      continue;
    assertRun(run, service.ctx, {
      paths: [".github/workflows/dev-nightly.yml"],
      events: ["schedule", "workflow_dispatch"],
      attempt: run.run_attempt,
    });
    demand(
      timestamp(run.updated_at) - timestamp(run.created_at) <=
        POLICY.qualification_max_duration_hours * 3600000,
      "Dev qualification invocation exceeded its duration limit; dispatch a new run",
    );
    if (!(await service.api.compatiblePolicy(run.head_sha))) continue;
    const artifacts = await service.api.pages(
      `/actions/runs/${run.id}/artifacts`,
      "artifacts",
    );
    const name = receiptName("dev", undefined, run.id, run.run_attempt);
    const matching = artifacts.filter(
      (item) => item.name === name && !item.expired,
    );
    demand(
      matching.length === 1,
      "Successful dev run lacks one current-attempt qualification receipt",
    );
    const artifact = matching[0];
    const ref = {
      repository: service.ctx.repository,
      stage: "dev",
      run_id: String(run.id),
      run_attempt: String(run.run_attempt),
      artifact_id: String(artifact.id),
      artifact_digest: artifact.digest,
    };
    const verified = await verifyReceipt(service, ref, undefined, {
      stage: "dev",
      maxAgeHours,
    });
    demand(
      await service.api.ancestor(verified.candidate.source_sha, main),
      "Dev source is no longer on main",
    );
    candidates.push({ ...verified.candidate, dev_receipt: verified.ref });
  }
  const selected = await newestByAncestry(service.api, candidates);
  const directory = await mkdtemp(join(tmpdir(), "opensesame-selection-"));
  try {
    const { manifest } = await service.verify(selected, directory);
    const state = await publicationState(
      service,
      selected,
      manifest,
      directory,
    );
    return {
      ...selected,
      dev_receipt: JSON.stringify(selected.dev_receipt),
      ...state,
      selection_cutoff: new Date(service.ctx.now).toISOString(),
      selected_main_sha: main,
      excluded_newer_main: String(main !== selected.source_sha),
    };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
