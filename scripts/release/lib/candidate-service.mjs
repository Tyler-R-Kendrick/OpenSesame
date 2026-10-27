import { mkdir } from "node:fs/promises";
import {
  GitHub,
  assertRun,
  sourceCi,
  successfulGate,
} from "./candidate-api.mjs";
import { verifyReceipt } from "./candidate-evidence.mjs";
import { envelope, verifyDirectory } from "./candidate-model.mjs";
import { POLICY, demand, timestamp } from "./candidate-policy.mjs";

export class Candidates {
  constructor(
    ctx,
    { api = new GitHub(ctx), download, provenance, policyHash } = {},
  ) {
    this.ctx = ctx;
    this.api = api;
    this.download =
      download ||
      (async (args) =>
        (await import("../artifact-transfer.mjs")).downloadArtifact(args));
    this.provenance =
      provenance ||
      (async (args) =>
        (await import("../provenance.mjs")).verifyCandidateProvenance(args));
    this.policyHash = policyHash || (() => this.api.policyHash());
  }

  artifactTime(metadata, run) {
    demand(
      timestamp(metadata.created_at) >= timestamp(run.run_started_at),
      "Artifact belongs to an earlier attempt",
    );
    demand(
      timestamp(metadata.created_at) <= this.ctx.now + 60000,
      "Artifact creation is in the future",
    );
    if (run.status === "completed")
      demand(
        timestamp(metadata.created_at) <= timestamp(run.updated_at),
        "Artifact postdates its producer",
      );
    demand(
      timestamp(metadata.expires_at) > this.ctx.now,
      "Artifact has expired",
    );
  }

  async verify(raw, directory, { prerequisite, downloaded } = {}) {
    const candidate = envelope(raw);
    const sameRun =
      candidate.run_id === this.ctx.runId &&
      candidate.run_attempt === this.ctx.runAttempt;
    const run = await this.api.attempt(candidate.run_id, candidate.run_attempt);
    assertRun(run, this.ctx, {
      paths: POLICY.producers,
      events: ["schedule", "workflow_dispatch"],
      completed: !sameRun,
      attempt: candidate.run_attempt,
    });
    successfulGate(
      await this.api.jobs(candidate.run_id, candidate.run_attempt),
      "Candidate build gate",
    );
    await mkdir(directory, { recursive: true });
    const metadata =
      downloaded ||
      (await this.download({
        repository: this.ctx.repository,
        token: this.ctx.token,
        artifactId: candidate.artifact_id,
        artifactDigest: candidate.artifact_digest,
        runId: candidate.run_id,
        runAttempt: candidate.run_attempt,
        destination: directory,
        expectedName: `${candidate.candidate_id}-complete`,
      }));
    this.artifactTime(metadata, run);
    const manifest = await verifyDirectory(directory, candidate);
    demand(
      manifest.producer.workflow_sha === run.head_sha,
      "Candidate producer control revision mismatch",
    );
    demand(
      manifest.producer.workflow_ref ===
        `${this.ctx.repository}/${run.path.split("@")[0]}@refs/heads/main`,
      "Candidate producer workflow does not match API",
    );
    demand(
      await this.api.compatiblePolicy(manifest.producer.workflow_sha),
      "Candidate build policy is incompatible",
    );
    await sourceCi(
      this.api,
      candidate.source_sha,
      manifest.source_ci.run_id,
      manifest.source_ci.run_attempt,
    );
    await this.provenance({
      directory,
      repository: this.ctx.repository,
      manifest,
      token: this.ctx.token,
    });
    if (prerequisite) {
      const ref = prerequisite.stage;
      demand(
        ["dev", "prerelease"].includes(ref),
        "Invalid verification prerequisite",
      );
      const options = { stage: ref };
      if (ref === "dev") options.maxAgeHours = POLICY.dev_max_age_hours;
      await verifyReceipt(this, prerequisite, candidate, options);
    }
    return { candidate, manifest, metadata };
  }

  async admission(controller) {
    demand(POLICY.enabled, "Candidate policy is disabled");
    demand(
      ["dev-nightly", "release-weekly", "candidate-build"].includes(controller),
      "Unknown controller policy",
    );
    demand(
      this.ctx.workflow === `.github/workflows/${controller}.yml`,
      "Controller policy mismatch",
    );
    const run = await this.api.attempt(this.ctx.runId, this.ctx.runAttempt);
    assertRun(run, this.ctx, {
      paths: [this.ctx.workflow],
      events: ["schedule", "workflow_dispatch"],
      sourceSha: this.ctx.workflowSha,
      completed: false,
      attempt: this.ctx.runAttempt,
    });
    const main = await this.api.main();
    demand(
      await this.api.ancestor(this.ctx.workflowSha, main),
      "Controller no longer belongs to main",
    );
    demand(
      await this.api.compatiblePolicy(main),
      "Qualification policy changed on main; start a new controller run",
    );
    await this.policyHash();
  }
}
