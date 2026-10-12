/** Match the verified-signature requirement enforced by the branch ruleset. */
export function assertPrSignatures(pr, commits, expectedHead) {
  if (!/^[a-f0-9]{40}$/.test(expectedHead) || pr.head?.sha !== expectedHead)
    throw new Error("PR head changed; rerun CI on the current head");
  if (
    !commits.length ||
    commits.length !== pr.commits ||
    commits.at(-1).sha !== expectedHead
  )
    throw new Error("Incomplete PR commit inventory; refusing signature check");
  const unsigned = commits.filter(
    (entry) => entry.commit?.verification?.verified !== true,
  );
  if (unsigned.length) {
    throw new Error(
      `Verified signatures required: ${unsigned.map((entry) => entry.sha).join(", ")}. Sign the introduced commits with a GitHub-registered signing key and push again; a green build alone cannot make unsigned commits mergeable.`,
    );
  }
}

/**
 * Merge-queue heads are GitHub-created commits. The ruleset still requires a
 * verified signature; check that one commit rather than a PR inventory.
 */
export function assertMergeGroupSignature(commit, expectedHead) {
  if (!/^[a-f0-9]{40}$/.test(expectedHead) || commit?.sha !== expectedHead) {
    throw new Error("merge_group head changed; rerun CI on the current head");
  }
  if (commit.commit?.verification?.verified !== true) {
    throw new Error(
      `Verified signatures required: merge_group head ${expectedHead} is not verified (${commit.commit?.verification?.reason ?? "no reason"}).`,
    );
  }
}
