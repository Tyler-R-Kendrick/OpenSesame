/**
 * Paths outside the Pages build that the live-join walk (ADR 0150) stands on:
 * the servers it runs, built or fetched pinned (`pnpm test:live-fixtures`).
 * `selectGates` counts them, as it does the relay-join walk's
 * (ci-relay-join.mjs), so a change to one runs the walk that uses it.
 */
export function liveJoinFixturePath(path) {
  return (
    path.startsWith("scripts/test/live-turn/") ||
    path === "scripts/test/live-fixtures.sh" ||
    path === "scripts/mtls/mtls-fixtures.sh"
  );
}
