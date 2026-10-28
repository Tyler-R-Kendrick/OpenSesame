import {
  CI_RECIPE,
  POLICY,
  demand,
  hash,
  identifier,
  sha,
  timestamp,
} from "./candidate-policy.mjs";

// Security tools read these paths from the candidate checkout. Include both
// present files and future additions so an older candidate cannot qualify under
// a controller that reviews different ignore rules or scanner settings.
const SCANNER_CONFIG_NAMES = new Set([
  ".gitleaks.toml",
  ".gitleaksignore",
  ".osv-scanner.toml",
  ".semgrepignore",
  ".semgrep.yml",
  ".semgrep.yaml",
  ".gitignore",
  "deny.toml",
  "osv-scanner.toml",
]);
const REQUIRED_SCANNER_CONFIGS = [
  ".github/codeql/codeql-config.yml",
  ".gitleaks.toml",
  ".cargo/audit.toml",
  "deny.toml",
  "osv-scanner.toml",
];

function scannerPolicyPath(path) {
  const parts = path.split("/");
  const name = parts.at(-1);
  return (
    SCANNER_CONFIG_NAMES.has(name) ||
    path.startsWith(".github/codeql/") ||
    parts.includes(".semgrep") ||
    (parts.includes(".cargo") &&
      ["audit.toml", "config", "config.toml"].includes(name)) ||
    path === "scripts/lib/audit-directory.sh" ||
    (path.startsWith("scripts/security/") && !path.includes(".test."))
  );
}

export function policyEntriesForTree(tree) {
  return [...tree]
    .filter(
      ([path]) =>
        (path.startsWith(".github/workflows/") && /\.ya?ml$/.test(path)) ||
        (path.startsWith("scripts/release/") && !path.includes(".test.")) ||
        (/^scripts\/(?:ci\/|lib\/ci-)/.test(path) &&
          !path.includes(".test.")) ||
        (path.startsWith("scripts/audit/") && path.endsWith("-gate.sh")) ||
        path.startsWith("tools/mutation/") ||
        path.startsWith("tools/security/") ||
        scannerPolicyPath(path) ||
        path === "scripts/fuzz/fuzz-batch.sh" ||
        CI_RECIPE.includes(path),
    )
    .sort(([a], [b]) => a.localeCompare(b));
}

export class GitHub {
  constructor(ctx, fetcher = fetch) {
    this.ctx = ctx;
    this.fetcher = fetcher;
    this.cache = new Map();
  }

  async get(path, { optional = false, binary = false } = {}) {
    demand(
      path.startsWith("/") &&
        !path.split("/").includes("..") &&
        !path.includes("\\"),
      "Invalid API path",
    );
    const response = await this.fetcher(
      `https://api.github.com/repos/${this.ctx.repository}${path}`,
      {
        headers: {
          Authorization: `Bearer ${this.ctx.token}`,
          Accept: binary
            ? "application/octet-stream"
            : "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
        },
        signal: AbortSignal.timeout(60000),
      },
    );
    if (optional && response.status === 404) return null;
    demand(
      response.ok,
      `GitHub request failed (${response.status}): ${path.split("?")[0]}`,
    );
    if (binary) {
      demand(response.body, "Metadata asset body is missing");
      const chunks = [];
      let size = 0;
      for await (const chunk of response.body) {
        size += chunk.length;
        demand(size <= 2 * 1024 * 1024, "Metadata asset is too large");
        chunks.push(chunk);
      }
      return Buffer.concat(chunks);
    }
    return response.json();
  }

  async pages(path, key) {
    const all = [];
    for (let page = 1; page <= POLICY.page_limit; page++) {
      const data = await this.get(
        `${path}${path.includes("?") ? "&" : "?"}per_page=100&page=${page}`,
      );
      const items = key ? data[key] : data;
      demand(Array.isArray(items), "Invalid paginated API response");
      all.push(...items);
      if (items.length < 100) return all;
    }
    throw new Error(
      "Selection is incomplete: API pagination safety limit reached",
    );
  }

  async attempt(id, attempt) {
    return this.get(
      `/actions/runs/${identifier(id)}/attempts/${identifier(attempt)}`,
    );
  }

  async jobs(id, attempt) {
    return this.pages(
      `/actions/runs/${identifier(id)}/attempts/${identifier(attempt)}/jobs`,
      "jobs",
    );
  }

  async ancestor(older, newer) {
    sha(older);
    sha(newer);
    if (older === newer) return true;
    const key = `${older}...${newer}`;
    if (!this.cache.has(key))
      this.cache.set(
        key,
        this.get(`/compare/${key}`).then(
          (result) =>
            result.base_commit?.sha === older &&
            ["ahead", "identical"].includes(result.status),
        ),
      );
    return this.cache.get(key);
  }

  async main() {
    return (await this.get("/git/ref/heads/main")).object.sha;
  }

  async compatibleCi(sourceSha) {
    return this.compatiblePolicy(sourceSha);
  }

  async tree(ref) {
    const key = `tree:${ref}`;
    if (!this.cache.has(key))
      this.cache.set(
        key,
        this.get(`/git/trees/${ref}?recursive=1`).then((data) => {
          demand(
            !data.truncated && Array.isArray(data.tree),
            "Incomplete Git tree cannot establish policy compatibility",
          );
          return new Map(
            data.tree
              .filter((item) => item.type === "blob")
              .map((item) => [item.path, item.sha]),
          );
        }),
      );
    return this.cache.get(key);
  }

  async policyEntries() {
    const tree = await this.tree(this.ctx.workflowSha);
    const entries = policyEntriesForTree(tree);
    for (const path of [...CI_RECIPE, ...REQUIRED_SCANNER_CONFIGS])
      demand(tree.has(path), `Current policy is incomplete: ${path}`);
    demand(
      entries.length >= 12,
      "Qualification policy inventory is incomplete",
    );
    return entries;
  }

  async compatiblePolicy(sourceSha) {
    const tree = await this.tree(sourceSha);
    return (
      JSON.stringify(await this.policyEntries()) ===
      JSON.stringify(policyEntriesForTree(tree))
    );
  }

  async policyHash() {
    return hash(
      JSON.stringify({ policy: POLICY, files: await this.policyEntries() }),
    );
  }
}

export function assertRun(
  run,
  ctx,
  { paths, events, sourceSha, completed = true, attempt } = {},
) {
  demand(
    run.repository?.full_name === ctx.repository &&
      run.head_repository?.full_name === ctx.repository,
    "Workflow repository/fork origin mismatch",
  );
  demand(run.head_branch === "main", "Workflow did not run against main");
  demand(
    paths.includes(run.path?.split("@")[0]),
    "Workflow path is not trusted",
  );
  demand(events.includes(run.event), "Workflow event is not trusted");
  if (sourceSha)
    demand(run.head_sha === sourceSha, "Workflow source SHA mismatch");
  if (attempt)
    demand(
      String(run.run_attempt) === String(attempt),
      "Workflow attempt mismatch",
    );
  if (completed)
    demand(
      run.status === "completed" && run.conclusion === "success",
      "Workflow attempt did not succeed",
    );
}

export function successfulGate(jobs, name) {
  const matches = jobs.filter(
    (job) => job.name === name || job.name.endsWith(` / ${name}`),
  );
  demand(matches.length === 1, `Expected one unambiguous gate: ${name}`);
  const job = matches[0];
  demand(
    job.status === "completed" && job.conclusion === "success",
    `Required gate did not succeed: ${name}`,
  );
  demand(
    job.completed_at &&
      timestamp(job.completed_at) >= timestamp(job.started_at),
    "Invalid gate completion time",
  );
  return job;
}

export async function sourceCi(
  api,
  sourceSha,
  runId,
  attempt,
  { compatible = true } = {},
) {
  const run = await api.attempt(runId, attempt);
  assertRun(run, api.ctx, {
    paths: [POLICY.ci_path],
    events: ["push"],
    sourceSha,
    attempt,
  });
  const jobs = await api.jobs(runId, attempt);
  for (const name of ["TypeScript", "Bundle budgets", "Rust"])
    successfulGate(jobs, name);
  demand(
    await api.ancestor(sourceSha, await api.main()),
    "Source is no longer on main",
  );
  if (compatible)
    demand(
      await api.compatibleCi(sourceSha),
      "Source CI recipe is incompatible with current policy",
    );
  return run;
}
