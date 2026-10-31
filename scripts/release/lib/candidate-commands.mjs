import { receiptEnvelope, writeReceipt } from "./candidate-evidence.mjs";
import { retainSelection, selectWeekly } from "./candidate-freeze.mjs";
import { candidateOutputs } from "./candidate-model.mjs";
import { demand, digest, identifier, stageKey } from "./candidate-policy.mjs";
import { verifyPromotion } from "./candidate-publication.mjs";
import { selectIntegration } from "./candidate-selection.mjs";

export const COMMAND_OPTIONS = {
  policy: ["--controller"],
  "select-integration": ["--workflow", "--reuse-complete", "--output"],
  "select-dev": [
    "--workflow",
    "--max-age-hours",
    "--selection-file",
    "--output",
  ],
  verify: ["--directory", "--prerequisite-env", "--output"],
  receipt: ["--stage", "--suite", "--needs-env", "--directory", "--output"],
  "receipt-envelope": [
    "--stage",
    "--suite",
    "--artifact-id",
    "--artifact-digest",
    "--output",
  ],
  "verify-promotion": ["--directory", "--output"],
};

async function integration(action) {
  demand(
    action.options["--workflow"] === ".github/workflows/ci.yml",
    "Untrusted source workflow",
  );
  const selected = await selectIntegration(action.service, {
    reuse: action.options["--reuse-complete"] === true,
  });
  await action.output(selected);
  await action.summary(selected, "Nightly integration selection");
}

async function dev(action) {
  demand(
    action.options["--workflow"] === ".github/workflows/dev-nightly.yml",
    "Untrusted dev workflow",
  );
  demand(
    action.options["--selection-file"],
    "--selection-file is required for weekly selection",
  );
  const selected = await selectWeekly(
    action.service,
    Number(action.options["--max-age-hours"] || 48),
  );
  await retainSelection(
    action.service,
    selected,
    action.options["--selection-file"],
  );
  await action.output(selected);
  const title =
    selected.promote === "false"
      ? "Already published: explicit no-op"
      : selected.resumed_from_attempt
        ? `Resuming selection from attempt ${selected.resumed_from_attempt}`
        : "Weekly candidate selected";
  await action.summary(selected, title);
}

async function verify(action) {
  const prerequisite = action.options["--prerequisite-env"]
    ? action.environmentJson(action.options["--prerequisite-env"])
    : undefined;
  const { manifest } = await action.service.verify(
    action.candidate(),
    action.directory(),
    { prerequisite },
  );
  await action.output(candidateOutputs(action.directory(), manifest));
}

async function receipt(action) {
  const stage = action.options["--stage"];
  const suite = action.options["--suite"];
  stageKey(stage, suite);
  const values = await writeReceipt(action.service, {
    candidate: action.candidate(),
    stage,
    suite,
    needs: action.environmentJson(
      action.options["--needs-env"] || "NEEDS_JSON",
    ),
    directory: action.directory(),
    prerequisite: action.environmentJson(
      "PREREQUISITE_RECEIPT",
      stage !== "dev",
    ),
  });
  await action.output(values);
}

async function receiptOutput(action) {
  const ref = receiptEnvelope({
    repository: action.ctx.repository,
    stage: action.options["--stage"],
    suite: action.options["--suite"],
    run_id: action.ctx.runId,
    run_attempt: action.ctx.runAttempt,
    artifact_id: identifier(action.options["--artifact-id"]),
    artifact_digest: digest(action.options["--artifact-digest"]),
  });
  await action.output({ receipt: JSON.stringify(ref) });
}

async function promotion(action) {
  const result = await verifyPromotion(
    action.service,
    action.candidate(),
    action.directory(),
    {
      prerelease: action.environmentJson("PRERELEASE_RECEIPT"),
      mutation: action.environmentJson("MUTATION_RECEIPT"),
      security: action.environmentJson("SECURITY_RECEIPT"),
    },
  );
  await action.output({
    ...candidateOutputs(action.directory(), result.manifest),
    evidence_directory: result.evidence_directory,
    tag: result.tag,
    version: result.version,
    promote: result.promote,
  });
}

export const COMMANDS = {
  policy: (action) => action.service.admission(action.options["--controller"]),
  "select-integration": integration,
  "select-dev": dev,
  verify,
  receipt,
  "receipt-envelope": receiptOutput,
  "verify-promotion": promotion,
};
