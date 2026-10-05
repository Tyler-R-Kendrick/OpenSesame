// Pure planning and payload helpers for replaying a local stack of branches
// as GitHub-verified commits through the createCommitOnBranch GraphQL
// mutation. Nothing here touches the network or the filesystem: every git
// call goes through an injected runner `git(args, { binary }) => string |
// Buffer`, so the logic is testable against a throwaway repository.

const MUTATION = `mutation($input: CreateCommitOnBranchInput!) {
  createCommitOnBranch(input: $input) {
    commit { oid url }
  }
}`;

const MODE_SYMLINK = "120000";
const MODE_SUBMODULE = "160000";
const MODE_EXEC = "100755";
const ZERO_MODE = "000000";

const short = (sha) => sha.slice(0, 12);

function refuse(sha, reason) {
  throw new Error(
    `Cannot replay commit ${short(sha)} through createCommitOnBranch: ${reason}`,
  );
}

/** Split a commit message into the mutation's headline and body. */
export function splitMessage(raw) {
  const text = raw.replace(/\r\n/g, "\n").replace(/\s+$/, "");
  const newline = text.indexOf("\n");
  if (newline === -1) return { headline: text, body: "" };
  return {
    headline: text.slice(0, newline),
    body: text.slice(newline + 1).replace(/^\n+/, ""),
  };
}

/** Parse `git diff-tree -r --no-renames -z --raw` output. */
export function parseRawDiff(output) {
  const tokens = output.split("\0");
  const entries = [];
  for (let i = 0; i < tokens.length; i += 1) {
    const meta = tokens[i];
    if (!meta.startsWith(":")) continue;
    const [oldMode, newMode, , , status] = meta.slice(1).split(" ");
    i += 1;
    entries.push({ oldMode, newMode, status: status[0], path: tokens[i] });
  }
  return entries;
}

function classify(sha, entry) {
  const { oldMode, newMode, status, path } = entry;
  for (const mode of [oldMode, newMode]) {
    if (mode === MODE_SYMLINK)
      refuse(sha, `${path} is a symlink (mode 120000)`);
    if (mode === MODE_SUBMODULE)
      refuse(sha, `${path} is a submodule (mode 160000)`);
  }
  if (status === "D") return "delete";
  if (status === "A") {
    if (newMode === MODE_EXEC)
      refuse(sha, `${path} is added with the executable bit (mode 100755)`);
    return "add";
  }
  if (status === "M") {
    if (oldMode !== newMode)
      refuse(
        sha,
        `${path} changes mode ${oldMode} -> ${newMode}; the executable bit cannot be expressed`,
      );
    return "add";
  }
  return refuse(sha, `${path} has unsupported change status ${status}`);
}

function planCommit(git, sha, parent) {
  const diff = git([
    "diff-tree",
    "-r",
    "--no-renames",
    "-z",
    "--raw",
    parent,
    sha,
  ]);
  const additions = [];
  const deletions = [];
  for (const entry of parseRawDiff(diff)) {
    if (entry.oldMode === ZERO_MODE && entry.newMode === ZERO_MODE) continue;
    if (classify(sha, entry) === "delete") {
      deletions.push({ path: entry.path });
      continue;
    }
    const contents = git(["show", `${sha}:${entry.path}`], { binary: true });
    additions.push({
      path: entry.path,
      contents: Buffer.from(contents).toString("base64"),
    });
  }
  const message = git(["show", "-s", "--format=%B", sha]);
  return { sha, parent, ...splitMessage(message), additions, deletions };
}

/**
 * Plan a stack: each branch's commits (oldest first) with their file changes,
 * every branch based on the one before it. Throws on anything the mutation
 * cannot express: symlinks, submodules, executable-bit changes, merges.
 */
export function planStack({ base, branches, git }) {
  const plan = [];
  let previous = base;
  for (const branch of branches) {
    const listing = git([
      "rev-list",
      "--reverse",
      "--parents",
      `${previous}..${branch}`,
    ]);
    const commits = [];
    for (const line of listing.split("\n").filter(Boolean)) {
      const [sha, ...parents] = line.trim().split(/\s+/);
      if (parents.length !== 1)
        refuse(
          sha,
          parents.length > 1
            ? "it is a merge commit"
            : "it has no parent (root commit)",
        );
      commits.push(planCommit(git, sha, parents[0]));
    }
    plan.push({ branch, base: previous, commits });
    previous = branch;
  }
  return plan;
}

/** The createCommitOnBranch request for one planned commit. */
export function buildMutation({ repo, branch, expectedHeadOid, change }) {
  return {
    query: MUTATION,
    variables: {
      input: {
        branch: { repositoryNameWithOwner: repo, branchName: branch },
        message: { headline: change.headline, body: change.body },
        fileChanges: {
          additions: change.additions.map(({ path, contents }) => ({
            path,
            contents,
          })),
          deletions: change.deletions.map(({ path }) => ({ path })),
        },
        expectedHeadOid,
      },
    },
  };
}
