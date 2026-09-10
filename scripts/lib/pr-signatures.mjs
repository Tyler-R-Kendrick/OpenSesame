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
