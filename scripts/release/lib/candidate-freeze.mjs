import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { assertRun, successfulGate } from "./candidate-api.mjs";
import { receiptEnvelope, verifyReceipt } from "./candidate-evidence.mjs";
import { envelope } from "./candidate-model.mjs";
import {
  POLICY,
  demand,
  identifier,
  sha,
  timestamp,
} from "./candidate-policy.mjs";
import { publicationState } from "./candidate-publication.mjs";
import { selectDev } from "./candidate-selection.mjs";

const WORKFLOW = ".github/workflows/release-weekly.yml";
const GATE = "Weekly selection";

export function selectionName(runId, attempt) {
  return `weekly-selection-${identifier(runId)}-${identifier(attempt)}`;
}

export async function validateSelection(service, record, attempt) {
  demand(
    record?.format === "opensesame-weekly-selection" &&
      record.schema_version === 1,
    "Unknown weekly selection schema",
  );
  demand(
    record.repository === service.ctx.repository,
    "Selection repository mismatch",
  );
  demand(
    record.producer?.run_id === service.ctx.runId &&
      record.producer.run_attempt === attempt,
    "Selection invocation mismatch",
  );
  demand(
    record.producer.workflow_ref ===
      `${service.ctx.repository}/${WORKFLOW}@refs/heads/main` &&
      record.producer.workflow_sha === service.ctx.workflowSha,
    "Selection controller revision mismatch",
  );
  demand(
    record.policy_sha256 === (await service.policyHash()),
    "Frozen selection policy changed",
  );
  const candidate = envelope(record.candidate);
  const dev = receiptEnvelope(record.dev_receipt);
  demand(
    dev.stage === "dev" && !dev.suite,
    "Frozen selection requires dev evidence",
  );
  sha(record.selected_main_sha);
  demand(
    timestamp(record.selection_cutoff) <= service.ctx.now,
    "Frozen selection cutoff is in the future",
  );
  return { ...record, candidate, dev_receipt: dev };
}

async function readSelection(service, run, gate, attempt) {
  const name = selectionName(service.ctx.runId, attempt);
  const artifacts = await service.api.pages(
    `/actions/runs/${service.ctx.runId}/artifacts`,
    "artifacts",
  );
  const matches = artifacts.filter((artifact) => artifact.name === name);
  demand(
    matches.length === 1,
    "Successful weekly selection has missing or ambiguous frozen evidence",
  );
  const artifact = matches[0];
  const directory = await mkdtemp(
    join(tmpdir(), "opensesame-frozen-selection-"),
  );
  try {
    const metadata = await service.download({
      repository: service.ctx.repository,
      token: service.ctx.token,
      artifactId: String(artifact.id),
      artifactDigest: artifact.digest,
      runId: service.ctx.runId,
      runAttempt: attempt,
      destination: directory,
      expectedName: name,
    });
    service.artifactTime(metadata, run);
    demand(
      timestamp(metadata.created_at) >= timestamp(gate.started_at) &&
        timestamp(metadata.created_at) <= timestamp(gate.completed_at),
      "Frozen selection artifact was not produced by the successful selection job",
    );
    demand(
      JSON.stringify(await readdir(directory)) === '["selection.json"]',
      "Unexpected selection artifact inventory",
    );
    const bytes = await readFile(join(directory, "selection.json"));
    demand(bytes.length <= 1024 * 1024, "Frozen selection is too large");
    const record = await validateSelection(service, JSON.parse(bytes), attempt);
    demand(
      timestamp(record.selection_cutoff) >= timestamp(gate.started_at) &&
        timestamp(record.selection_cutoff) <= timestamp(metadata.created_at),
      "Frozen selection cutoff is outside its original selection job",
    );
    return record;
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

export async function previousSelection(service) {
  const current = Number(identifier(service.ctx.runAttempt));
  demand(
    current <= POLICY.selection_attempt_limit,
    "Weekly retry history exceeds the safety limit; start a new run",
  );
  for (let number = 1; number < current; number++) {
    const attempt = String(number);
    const run = await service.api.attempt(service.ctx.runId, attempt);
    assertRun(run, service.ctx, {
      paths: [WORKFLOW],
      events: ["schedule", "workflow_dispatch"],
      sourceSha: service.ctx.workflowSha,
      completed: false,
      attempt,
    });
    demand(
      run.status === "completed",
      "Earlier weekly attempt has not completed",
    );
    const jobs = await service.api.jobs(service.ctx.runId, attempt);
    const matching = jobs.filter(
      (job) => job.name === GATE || job.name.endsWith(` / ${GATE}`),
    );
    demand(matching.length <= 1, "Ambiguous weekly selection job");
    if (!matching.length) continue;
    if (
      matching[0].status !== "completed" ||
      matching[0].conclusion !== "success"
    )
      continue;
    return readSelection(service, run, successfulGate(jobs, GATE), attempt);
  }
  return null;
}

export async function resumeSelection(service, record, dependencies = {}) {
  const verifyDev = dependencies.verifyDev || verifyReceipt;
  const publication = dependencies.publication || publicationState;
  await verifyDev(service, record.dev_receipt, record.candidate, {
    stage: "dev",
    maxAgeHours: POLICY.dev_max_age_hours,
  });
  demand(
    await service.api.ancestor(
      record.candidate.source_sha,
      record.selected_main_sha,
    ),
    "Frozen candidate is not contained in its selected main snapshot",
  );
  demand(
    await service.api.ancestor(
      record.selected_main_sha,
      await service.api.main(),
    ),
    "Frozen main snapshot is no longer on main",
  );
  const directory = await mkdtemp(
    join(tmpdir(), "opensesame-resume-selection-"),
  );
  try {
    const { manifest } = await service.verify(record.candidate, directory);
    const state = await publication(
      service,
      record.candidate,
      manifest,
      directory,
    );
    return {
      ...record.candidate,
      dev_receipt: JSON.stringify(record.dev_receipt),
      ...state,
      selection_cutoff: record.selection_cutoff,
      selected_main_sha: record.selected_main_sha,
      excluded_newer_main: String(
        record.selected_main_sha !== record.candidate.source_sha,
      ),
      resumed_from_attempt: record.producer.run_attempt,
    };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

export async function selectWeekly(service, maxAgeHours, dependencies = {}) {
  await service.admission("release-weekly");
  demand(
    maxAgeHours === POLICY.dev_max_age_hours,
    "Dev freshness cannot override current policy",
  );
  const frozen = await previousSelection(service);
  if (frozen) return (dependencies.resume || resumeSelection)(service, frozen);
  return (dependencies.choose || selectDev)(service, maxAgeHours);
}

export async function retainSelection(service, selected, path) {
  demand(path, "--selection-file is required for weekly selection");
  const record = {
    format: "opensesame-weekly-selection",
    schema_version: 1,
    repository: service.ctx.repository,
    producer: {
      run_id: service.ctx.runId,
      run_attempt: service.ctx.runAttempt,
      workflow_ref: service.ctx.workflowRef,
      workflow_sha: service.ctx.workflowSha,
    },
    policy_sha256: await service.policyHash(),
    candidate: envelope(selected),
    dev_receipt: receiptEnvelope(JSON.parse(selected.dev_receipt)),
    selection_cutoff: selected.selection_cutoff,
    selected_main_sha: selected.selected_main_sha,
  };
  await validateSelection(service, record, service.ctx.runAttempt);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(record)}\n`, { flag: "wx" });
}
