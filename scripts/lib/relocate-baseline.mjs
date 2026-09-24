/**
 * Relocation for the structural-complexity ledger (ADR 0133 §6).
 *
 * `quality-baseline.json` is keyed by path, so a file that moves looks like a
 * brand-new file with debt (allowed 0) plus an unrecorded improvement at the
 * old path. `--accept-new-debt` gets past that by letting numbers rise, which
 * is broader than a move needs. Relocation instead carries each recorded
 * entry from its old path to its new one, unchanged, and refuses anything that
 * is not a plain move:
 *
 *   - the old path must no longer exist, and must differ from the new one
 *   - the new path must not already have a baseline entry
 *
 * A moved file with no recorded entry carries nothing and is not an error.
 *
 * The caller then runs the ordinary ratchet against the re-keyed ledger, so a
 * moved file that got worse still fails, and one that got better must still
 * record the improvement.
 */

/**
 * @param {Record<string, Record<string, number>>} baseline  path -> rule -> number
 * @param {Record<string, string>} map  old path -> new path
 * @param {(path: string) => boolean} stillExists  whether a path is still on disk
 * @returns {{ files: Record<string, Record<string, number>>, moved: number, refusals: string[] }}
 */
export function relocateBaseline(baseline, map, stillExists) {
  const files = { ...baseline };
  const refusals = [];
  let moved = 0;
  for (const [from, to] of Object.entries(map)) {
    if (from === to) {
      refusals.push(`${from}: maps to itself`);
    } else if (stillExists(from)) {
      refusals.push(`${from}: still exists, so this is not a move`);
    } else if (files[to]) {
      refusals.push(`${to}: already has a baseline entry`);
    } else if (files[from]) {
      files[to] = { ...files[from] };
      delete files[from];
      moved += 1;
    }
    // A moved file with no recorded debt carries nothing; that is not an error.
  }
  return { files, moved, refusals };
}

/**
 * A relocation map is `{ "moves": { "old": "new", ... } }` with repo-relative
 * POSIX paths. Anything else is refused rather than guessed at.
 *
 * @param {unknown} parsed
 * @returns {Record<string, string>}
 */
export function readRelocationMap(parsed) {
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    typeof parsed.moves !== "object" ||
    parsed.moves === null ||
    Array.isArray(parsed.moves)
  ) {
    throw new Error('relocation map must be { "moves": { "old": "new" } }');
  }
  const moves = {};
  for (const [from, to] of Object.entries(parsed.moves)) {
    if (typeof to !== "string" || to.length === 0 || from.length === 0) {
      throw new Error(`relocation map entry for ${from} is not a path`);
    }
    if (
      from.startsWith("/") ||
      to.startsWith("/") ||
      from.includes("\\") ||
      to.includes("\\")
    ) {
      throw new Error(`relocation map paths must be repo-relative: ${from}`);
    }
    moves[from] = to;
  }
  return moves;
}
