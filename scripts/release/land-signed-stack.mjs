// Replay a LOCAL stack of branches onto GitHub as verified commits.
//
//   node scripts/release/land-signed-stack.mjs \
//     --repo OWNER/REPO --base main --branches b1,b2,b3 [--suffix -signed] [--apply]
//
// The ruleset requires every commit in a PR to be GitHub-verified, and only
// commits GitHub itself creates (createCommitOnBranch) qualify. Run this where
// `gh` is logged in: it creates `<branch><suffix>` refs, each starting at the
// previous branch's new head (the first at the remote head of --base), replays
// every local commit through the mutation, threading expectedHeadOid, and
// reports commit.verification.verified for every commit it made. Exit is
// non-zero if any is unverified or its tree differs from the local commit.
//
// Default is a DRY RUN that prints the plan and touches nothing (no gh call).
// It never force-pushes, never deletes a branch and never merges; open the
// PRs from the `-signed` branches yourself.
//
// HONESTY: this was tested offline only (the plan, the payloads, the refusals
// and the dry run). The live GitHub calls (refs, GraphQL, verification
// readback) were NOT exercised from the environment that wrote it.

import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { buildMutation, planStack } from "../lib/signed-replay.mjs";

const MAX_BUFFER = 256 * 1024 * 1024;
const USAGE =
  "Usage: land-signed-stack.mjs --repo OWNER/REPO --base REF --branches b1,b2 [--suffix -signed] [--apply]";

export function parseArgs(argv) {
  const opts = { suffix: "-signed", apply: false };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (flag === "--apply") opts.apply = true;
    else if (["--repo", "--base", "--branches", "--suffix"].includes(flag)) {
      i += 1;
      if (argv[i] === undefined)
        throw new Error(`${flag} needs a value\n${USAGE}`);
      opts[flag.slice(2)] = argv[i];
    } else throw new Error(`Unknown argument ${flag}\n${USAGE}`);
  }
  if (!/^[\w.-]+\/[\w.-]+$/.test(opts.repo ?? ""))
    throw new Error(`--repo OWNER/REPO is required\n${USAGE}`);
  if (!opts.base) throw new Error(`--base is required\n${USAGE}`);
  opts.branches = (opts.branches ?? "").split(",").filter(Boolean);
  if (!opts.branches.length)
    throw new Error(`--branches is required\n${USAGE}`);
  if (!opts.suffix) throw new Error("--suffix must not be empty");
  return opts;
}

const localGit = (args, { binary = false } = {}) =>
  execFileSync("git", args, {
    encoding: binary ? "buffer" : "utf8",
    maxBuffer: MAX_BUFFER,
  });

function gh(args, input) {
  return JSON.parse(
    execFileSync("gh", args, {
      encoding: "utf8",
      input,
      maxBuffer: MAX_BUFFER,
    }),
  );
}

export function describePlan(plan) {
  const lines = [];
  for (const { branch, base, commits } of plan) {
    const files = commits.reduce(
      (n, c) => n + c.additions.length + c.deletions.length,
      0,
    );
    const bytes = commits.reduce(
      (n, c) =>
        n +
        c.additions.reduce(
          (m, a) => m + Buffer.from(a.contents, "base64").length,
          0,
        ),
      0,
    );
    lines.push(
      `${branch} (on ${base}): ${commits.length} commits, ${files} file changes, ${bytes} bytes`,
    );
    for (const c of commits)
      lines.push(
        `  ${c.sha.slice(0, 12)} +${c.additions.length} -${c.deletions.length} ${c.headline}`,
      );
  }
  return lines.join("\n");
}

function apply({ repo, base, suffix }, plan) {
  const baseBranch = base.replace(/^origin\//, "");
  const remoteBase = gh(["api", `repos/${repo}/git/ref/heads/${baseBranch}`])
    .object.sha;
  const localBase = localGit(["rev-parse", `${base}^{commit}`]).trim();
  if (remoteBase !== localBase)
    throw new Error(
      `Remote ${baseBranch} is ${remoteBase} but local ${base} is ${localBase}; update the local base first`,
    );
  let head = remoteBase;
  const created = [];
  for (const { branch, commits } of plan) {
    const name = `${branch}${suffix}`;
    gh([
      "api",
      `repos/${repo}/git/refs`,
      "-f",
      `ref=refs/heads/${name}`,
      "-f",
      `sha=${head}`,
    ]);
    console.log(`created refs/heads/${name} at ${head}`);
    for (const change of commits) {
      const request = buildMutation({
        repo,
        branch: name,
        expectedHeadOid: head,
        change,
      });
      const reply = gh(
        ["api", "graphql", "--input", "-"],
        JSON.stringify(request),
      );
      head = reply.data.createCommitOnBranch.commit.oid;
      created.push({ branch: name, oid: head, local: change.sha });
      console.log(`  ${change.sha.slice(0, 12)} -> ${head} ${change.headline}`);
    }
  }
  return created;
}

function verify(repo, created) {
  let failed = 0;
  for (const { branch, oid, local } of created) {
    const { commit } = gh(["api", `repos/${repo}/commits/${oid}`]);
    const verified = commit.verification?.verified === true;
    const sameTree =
      commit.tree?.sha === localGit(["rev-parse", `${local}^{tree}`]).trim();
    if (!verified || !sameTree) failed += 1;
    console.log(
      `${verified ? "verified  " : "UNVERIFIED"} ${sameTree ? "tree ok " : "TREE DIFFERS"} ${oid} ${branch} (${commit.verification?.reason ?? "no reason"})`,
    );
  }
  return failed;
}

export function main(argv) {
  const opts = parseArgs(argv);
  const plan = planStack({
    base: opts.base,
    branches: opts.branches,
    git: localGit,
  });
  console.log(describePlan(plan));
  if (!opts.apply) {
    console.log(
      "\nDry run: nothing was sent. Pass --apply to create the refs and commits.",
    );
    return 0;
  }
  const created = apply(opts, plan);
  const failed = verify(opts.repo, created);
  if (failed) console.error(`${failed} commit(s) failed verification`);
  return failed ? 1 : 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
