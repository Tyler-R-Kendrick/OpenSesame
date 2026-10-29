import { createHash } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isString } from "../../lib/json-boundary.mjs";

export const ROOT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../..",
);
export const POLICY = Object.freeze({
  schema_version: 1,
  repository: "Tyler-R-Kendrick/OpenSesame",
  branch: "main",
  enabled: true,
  retention_days: 35,
  dev_max_age_hours: 48,
  qualification_max_duration_hours: 24,
  source_walk_limit: 100,
  selection_attempt_limit: 100,
  page_limit: 20,
  ci_path: ".github/workflows/ci.yml",
  producers: [
    ".github/workflows/dev-nightly.yml",
    ".github/workflows/candidate-build.yml",
  ],
  stages: {
    dev: { workflow: ".github/workflows/dev-nightly.yml", gate: "Dev gate" },
    prerelease: {
      workflow: ".github/workflows/release-weekly.yml",
      gate: "Prerelease gate",
    },
    mutation: {
      workflow: ".github/workflows/release-weekly.yml",
      gate: "Release mutation gate",
    },
    security: {
      workflow: ".github/workflows/release-weekly.yml",
      gate: "Release security gate",
    },
  },
});

export const CI_RECIPE = [
  POLICY.ci_path,
  "package.json",
  "scripts/lib/ci-main-baseline.mjs",
  "scripts/lib/ci-required-result.mjs",
  "scripts/lib/ci-changed-areas.mjs",
  "scripts/lib/ci-affected-tests.mjs",
  "scripts/lib/ci-affected-builds.mjs",
  "scripts/lib/ci-affected-graph.mjs",
  "scripts/lib/ci-scoped-tests.mjs",
  "scripts/lib/ci-gates.mjs",
  "scripts/lib/json-boundary.mjs",
  "scripts/lib/pr-signatures.mjs",
  "scripts/lib/pages-release.mjs",
];

export function demand(condition, message) {
  if (!condition) throw new Error(message);
}

export function sha(value, label = "SHA") {
  demand(isString(value) && /^[a-f0-9]{40}$/.test(value), `Invalid ${label}`);
  return value;
}

export function identifier(value, label = "identifier") {
  const text = String(value ?? "");
  demand(
    /^[1-9][0-9]*$/.test(text) && Number.isSafeInteger(Number(text)),
    `Invalid ${label}`,
  );
  return text;
}

export function digest(value, label = "digest") {
  const text = String(value ?? "").replace(/^sha256:/, "");
  demand(/^[a-f0-9]{64}$/.test(text), `Invalid ${label}`);
  return text;
}

export function hash(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

export function timestamp(value, label = "timestamp") {
  const result = Date.parse(value);
  demand(Number.isFinite(result), `Invalid ${label}`);
  return result;
}

export function stageKey(stage, suite) {
  demand(
    ["dev", "prerelease", "release-qualified"].includes(stage),
    "Unknown qualification stage",
  );
  if (stage === "release-qualified") {
    demand(
      ["mutation", "security"].includes(suite),
      "Deep qualification requires an explicit suite",
    );
    return suite;
  }
  demand(!suite, "Unexpected qualification suite");
  return stage;
}

export function context(env = process.env, { requireToken = true } = {}) {
  demand(
    env.GITHUB_ACTIONS === "true",
    "Candidate operations require GitHub Actions",
  );
  demand(env.GITHUB_REPOSITORY === POLICY.repository, "Untrusted repository");
  demand(
    env.GITHUB_REF === "refs/heads/main",
    "Candidate controller must run from main",
  );
  demand(
    ["schedule", "workflow_dispatch"].includes(env.GITHUB_EVENT_NAME),
    "Untrusted controller event",
  );
  const workflowRef = String(env.GITHUB_WORKFLOW_REF ?? "");
  const prefix = `${POLICY.repository}/`;
  demand(
    workflowRef.startsWith(prefix) && workflowRef.endsWith("@refs/heads/main"),
    "Untrusted workflow ref",
  );
  const workflow = workflowRef.slice(prefix.length, -"@refs/heads/main".length);
  demand(
    [...POLICY.producers, ".github/workflows/release-weekly.yml"].includes(
      workflow,
    ),
    "Untrusted controller",
  );
  if (requireToken)
    demand(env.GH_TOKEN || env.GITHUB_TOKEN, "GitHub token is required");
  return {
    repository: POLICY.repository,
    token: env.GH_TOKEN || env.GITHUB_TOKEN,
    runId: identifier(env.GITHUB_RUN_ID),
    runAttempt: identifier(env.GITHUB_RUN_ATTEMPT),
    workflow,
    workflowRef,
    workflowSha: sha(env.GITHUB_WORKFLOW_SHA),
    now: Date.now(),
  };
}
