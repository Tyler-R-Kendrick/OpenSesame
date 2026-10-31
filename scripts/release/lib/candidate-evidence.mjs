import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { isJsonObject } from "../../lib/json-boundary.mjs";
import { assertRun, successfulGate } from "./candidate-api.mjs";
import { envelope, sameCandidate } from "./candidate-model.mjs";
import {
  POLICY,
  demand,
  digest,
  identifier,
  sha,
  stageKey,
  timestamp,
} from "./candidate-policy.mjs";

export function receiptName(stage, suite, runId, attempt) {
  stageKey(stage, suite);
  return `qualification-${stage}${suite ? `-${suite}` : ""}-${identifier(runId)}-${identifier(attempt)}`;
}

export function receiptEnvelope(input) {
  demand(isJsonObject(input), "Receipt envelope is missing");
  demand(input.repository === POLICY.repository, "Receipt repository mismatch");
  stageKey(input.stage, input.suite);
  const result = {
    repository: input.repository,
    stage: input.stage,
    run_id: identifier(input.run_id),
    run_attempt: identifier(input.run_attempt),
    artifact_id: identifier(input.artifact_id),
    artifact_digest: digest(input.artifact_digest),
  };
  if (input.suite) result.suite = input.suite;
  return result;
}

export function validateNeeds(needs) {
  demand(
    isJsonObject(needs) && Object.keys(needs).length > 0,
    "Qualification requires nonempty dependency evidence",
  );
  for (const [name, item] of Object.entries(needs)) {
    demand(
      item?.result === "success",
      `Qualification prerequisite did not succeed: ${name}`,
    );
  }
}

export function validateReceipt(receipt, ref, expected, policyHash, now) {
  const key = stageKey(ref.stage, ref.suite);
  const rule = POLICY.stages[key];
  demand(
    receipt?.format === "opensesame-qualification" &&
      receipt.schema_version === 1,
    "Unknown receipt schema",
  );
  demand(
    receipt.stage === ref.stage && receipt.suite === ref.suite,
    "Qualification stage/suite substitution",
  );
  demand(receipt.policy_sha256 === policyHash, "Qualification policy changed");
  demand(
    sameCandidate(receipt.candidate, expected),
    "Receipt candidate identity mismatch",
  );
  demand(
    receipt.repository === POLICY.repository,
    "Receipt repository mismatch",
  );
  demand(
    String(receipt.producer?.run_id) === ref.run_id &&
      String(receipt.producer?.run_attempt) === ref.run_attempt,
    "Receipt invocation mismatch",
  );
  demand(
    receipt.producer.workflow_ref ===
      `${POLICY.repository}/${rule.workflow}@refs/heads/main`,
    "Receipt workflow mismatch",
  );
  sha(receipt.producer.workflow_sha);
  demand(
    Array.isArray(receipt.checks) && receipt.checks.length === 1,
    "Receipt required scope mismatch",
  );
  const check = receipt.checks[0];
  demand(
    check.scope === rule.gate && check.result === "success",
    "Receipt required gate missing",
  );
  identifier(check.job_id, "qualification job ID");
  demand(
    timestamp(receipt.completed_at) === timestamp(check.completed_at),
    "Receipt completion does not match gate",
  );
  demand(
    timestamp(receipt.completed_at) <= now + 60000,
    "Receipt completion is in the future",
  );
  if (ref.stage === "dev")
    demand(
      receipt.prerequisite === null,
      "Dev receipt has an unexpected prerequisite",
    );
  else
    demand(
      isJsonObject(receipt.prerequisite) || Array.isArray(receipt.prerequisite),
      "Receipt prerequisite missing",
    );
  return receipt;
}

export async function verifyReceipt(
  service,
  raw,
  expected,
  { stage, suite, maxAgeHours, depth = 0 } = {},
) {
  demand(depth <= 2, "Qualification chain is too deep");
  const ref = receiptEnvelope(raw);
  const key = stageKey(ref.stage, ref.suite);
  demand(
    ref.stage === stage && ref.suite === suite,
    "Unexpected receipt stage or suite",
  );
  const sameRun =
    ref.run_id === service.ctx.runId &&
    ref.run_attempt === service.ctx.runAttempt;
  const run = await service.api.attempt(ref.run_id, ref.run_attempt);
  assertRun(run, service.ctx, {
    paths: [POLICY.stages[key].workflow],
    events: ["schedule", "workflow_dispatch"],
    completed: !sameRun,
    attempt: ref.run_attempt,
  });
  const directory = await mkdtemp(join(tmpdir(), "opensesame-receipt-"));
  try {
    const metadata = await service.download({
      repository: service.ctx.repository,
      token: service.ctx.token,
      artifactId: ref.artifact_id,
      artifactDigest: ref.artifact_digest,
      runId: ref.run_id,
      runAttempt: ref.run_attempt,
      destination: directory,
      expectedName: receiptName(
        ref.stage,
        ref.suite,
        ref.run_id,
        ref.run_attempt,
      ),
    });
    service.artifactTime(metadata, run);
    demand(
      JSON.stringify((await readdir(directory)).sort()) === '["receipt.json"]',
      "Receipt artifact inventory mismatch",
    );
    const bytes = await readFile(join(directory, "receipt.json"));
    demand(bytes.length <= 1024 * 1024, "Receipt is too large");
    const parsed = JSON.parse(bytes);
    const candidate = expected || envelope(parsed.candidate);
    const receipt = validateReceipt(
      parsed,
      ref,
      candidate,
      await service.policyHash(),
      service.ctx.now,
    );
    demand(
      run.head_sha === receipt.producer.workflow_sha,
      "Receipt control revision mismatch",
    );
    const job = successfulGate(
      await service.api.jobs(ref.run_id, ref.run_attempt),
      POLICY.stages[key].gate,
    );
    demand(
      String(job.id) === String(receipt.checks[0].job_id) &&
        job.completed_at === receipt.completed_at,
      "Receipt does not identify the successful API gate",
    );
    if (maxAgeHours !== undefined) {
      demand(
        service.ctx.now - timestamp(receipt.completed_at) <=
          maxAgeHours * 3600000,
        "Qualification evidence expired",
      );
    }
    if (stage === "prerelease") {
      await verifyReceipt(service, receipt.prerequisite, candidate, {
        stage: "dev",
        maxAgeHours: POLICY.dev_max_age_hours,
        depth: depth + 1,
      });
    } else if (stage === "release-qualified") {
      await verifyReceipt(service, receipt.prerequisite, candidate, {
        stage: "prerelease",
        depth: depth + 1,
      });
    }
    return { ref, receipt, candidate };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

export async function writeReceipt(
  service,
  { candidate, stage, suite, needs, directory, prerequisite },
) {
  validateNeeds(needs);
  const key = stageKey(stage, suite);
  const rule = POLICY.stages[key];
  demand(
    service.ctx.workflow === rule.workflow,
    "This controller cannot issue that qualification",
  );
  const run = await service.api.attempt(
    service.ctx.runId,
    service.ctx.runAttempt,
  );
  assertRun(run, service.ctx, {
    paths: [rule.workflow],
    events: ["schedule", "workflow_dispatch"],
    sourceSha: service.ctx.workflowSha,
    completed: false,
    attempt: service.ctx.runAttempt,
  });
  const job = successfulGate(
    await service.api.jobs(service.ctx.runId, service.ctx.runAttempt),
    rule.gate,
  );
  if (stage !== "dev") {
    const options = { stage: stage === "prerelease" ? "dev" : "prerelease" };
    if (stage === "prerelease") options.maxAgeHours = POLICY.dev_max_age_hours;
    await verifyReceipt(service, prerequisite, candidate, options);
  } else
    demand(!prerequisite, "Dev qualification cannot inherit another receipt");
  const receipt = {
    format: "opensesame-qualification",
    schema_version: 1,
    repository: service.ctx.repository,
    stage,
    candidate: envelope(candidate),
    policy_sha256: await service.policyHash(),
    producer: {
      run_id: service.ctx.runId,
      run_attempt: service.ctx.runAttempt,
      workflow_ref: service.ctx.workflowRef,
      workflow_sha: service.ctx.workflowSha,
    },
    completed_at: job.completed_at,
    checks: [
      {
        scope: rule.gate,
        job_id: String(job.id),
        result: "success",
        completed_at: job.completed_at,
      },
    ],
    prerequisite: prerequisite ? receiptEnvelope(prerequisite) : null,
  };
  if (suite) receipt.suite = suite;
  await mkdir(directory, { recursive: true });
  const path = resolve(directory, "receipt.json");
  await writeFile(path, `${JSON.stringify(receipt)}\n`, { flag: "wx" });
  return {
    receipt_path: path,
    receipt_name: receiptName(
      stage,
      suite,
      service.ctx.runId,
      service.ctx.runAttempt,
    ),
  };
}
