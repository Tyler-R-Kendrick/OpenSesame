import { execFileSync, spawnSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SHA = /^[0-9a-f]{40}$/;
const WORKFLOW = ".github/workflows/ci.yml";

/** Select by source ancestry, never completion order or the latest push's before. */
export function chooseSuccessfulMainBaseline(runs, options) {
  const { headSha, currentRunId, repository, cutoff, isAncestor, distance } =
    options;
  if (!SHA.test(headSha) || !Number.isFinite(Date.parse(cutoff))) {
    throw new Error("invalid main revision or selection cutoff");
  }
  const eligible = runs.filter(
    (run) =>
      run.event === "push" &&
      run.head_branch === "main" &&
      run.path === WORKFLOW &&
      run.status === "completed" &&
      run.conclusion === "success" &&
      run.head_repository?.full_name === repository &&
      String(run.id) !== String(currentRunId) &&
      SHA.test(run.head_sha ?? "") &&
      run.head_sha !== headSha &&
      Date.parse(run.created_at) <= Date.parse(cutoff) &&
      isAncestor(run.head_sha, headSha),
  );
  const candidates = [...new Set(eligible.map((run) => run.head_sha))].map(
    (sha) => ({ sha, distance: distance(sha, headSha) }),
  );
  if (
    candidates.some(
      (candidate) =>
        !Number.isInteger(candidate.distance) || candidate.distance < 1,
    )
  ) {
    throw new Error("invalid ancestor distance");
  }
  candidates.sort(
    (a, b) => a.distance - b.distance || a.sha.localeCompare(b.sha),
  );
  return candidates[0]?.sha ?? "";
}

async function request(path) {
  const token = process.env.GH_TOKEN;
  if (!token)
    throw new Error("no token to resolve the successful main baseline");
  const response = await fetch(`https://api.github.com${path}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
    },
    signal: AbortSignal.timeout(20000),
  });
  if (!response.ok)
    throw new Error(`GitHub baseline lookup failed (${response.status})`);
  return response.json();
}

async function successfulMainBaseline(headSha) {
  const repository = process.env.GITHUB_REPOSITORY ?? "";
  const currentRunId = process.env.GITHUB_RUN_ID ?? "";
  if (
    !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository) ||
    !/^\d+$/.test(currentRunId)
  ) {
    throw new Error("invalid repository or current run identity");
  }
  const current = await request(
    `/repos/${repository}/actions/runs/${currentRunId}`,
  );
  if (
    current.head_sha !== headSha ||
    current.event !== "push" ||
    current.head_branch !== "main"
  ) {
    throw new Error(
      "current main run metadata does not match the checked revision",
    );
  }
  const runs = [];
  for (let page = 1; page <= 10; page += 1) {
    const data = await request(
      `/repos/${repository}/actions/workflows/ci.yml/runs?branch=main&event=push&status=success&per_page=100&page=${page}`,
    );
    if (
      !Array.isArray(data.workflow_runs) ||
      !Number.isInteger(data.total_count)
    ) {
      throw new Error("incomplete successful-run response");
    }
    runs.push(...data.workflow_runs);
    // Any verified successful ancestor is a safe lower bound: choosing an
    // older one only adds work. Do not fetch years of history once one is found.
    const baseline = chooseSuccessfulMainBaseline(runs, {
      headSha,
      currentRunId,
      repository,
      cutoff: current.created_at,
      isAncestor: (base, head) =>
        spawnSync("git", ["merge-base", "--is-ancestor", base, head]).status ===
        0,
      distance: (base, head) =>
        Number(
          execFileSync("git", ["rev-list", "--count", `${base}..${head}`], {
            encoding: "utf8",
          }).trim(),
        ),
    });
    if (baseline) return baseline;
    if (runs.length >= data.total_count) return "";
    if (data.workflow_runs.length < 100)
      throw new Error("truncated successful-run history");
  }
  throw new Error("successful-run history exceeds the complete lookup limit");
}

export async function resolveChangeScope(env, lookup = successfulMainBaseline) {
  const head = env.HEAD_SHA || env.GITHUB_SHA || "";
  let base = env.BASE_SHA || "";
  if (
    env.GITHUB_EVENT_NAME === "push" &&
    env.GITHUB_REF === "refs/heads/main"
  ) {
    base = await lookup(head);
  }
  if (!SHA.test(base) || !SHA.test(head)) {
    return { base_sha: "", head_sha: SHA.test(head) ? head : "", scope: "all" };
  }
  return { base_sha: base, head_sha: head, scope: "diff" };
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  let scope;
  try {
    scope = await resolveChangeScope(process.env);
  } catch (error) {
    console.error(
      `CI baseline: ${error.message}; selecting the full fast suite`,
    );
    scope = {
      base_sha: "",
      head_sha: process.env.GITHUB_SHA ?? "",
      scope: "all",
    };
  }
  const text = `${Object.entries(scope)
    .map(([key, value]) => `${key}=${value}`)
    .join("\n")}\n`;
  if (process.env.GITHUB_OUTPUT)
    appendFileSync(process.env.GITHUB_OUTPUT, text);
  console.log(text.trim());
}
