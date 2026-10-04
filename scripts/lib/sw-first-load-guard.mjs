/**
 * Browser walks that let service workers run must outwait the first load's
 * reload.
 *
 * A device's first load runs under no worker. The core worker installs, claims
 * the page, and the page reloads once, by design, discarding whatever the walk
 * has done in the document it was in -- an opened guest vault included. A walk
 * that clicks the front door before that reload is a flake that scales with
 * how slow the machine is (`verify:push`, 2 runs in 15 unloaded).
 * `apps/pages/scripts/lib/push-worker-harness.mjs` holds the cure
 * (`trackControlledBirth` on the context, `untilBornControlled` on the page);
 * this is the guard that keeps every walk using it.
 *
 * Pure: it reads text and knows nothing about disk.
 */

/** A script under the Pages scripts directory (the guard's own scope). */
export function isWalkScript(path) {
  return /^apps\/pages\/scripts\/.+\.mjs$/.test(path) && !isTestFile(path);
}

const isTestFile = (path) => /\.test\.mjs$/.test(path);

/** Source with comments blanked, keeping a `//` inside a URL. */
export function withoutComments(text) {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|[^:\\'"`])\/\/[^\n]*/g, "$1");
}

/** Whether the script opens a context in which service workers run. */
export function allowsServiceWorkers(text) {
  return /\bserviceWorkers\s*:\s*["'`]allow["'`]/.test(withoutComments(text));
}

/** Which of the two halves of the cure the script calls. */
export function firstLoadCalls(text) {
  const code = withoutComments(text);
  return {
    tracks: /\btrackControlledBirth\s*\(/.test(code),
    waits: /\buntilBornControlled\s*\(/.test(code),
  };
}

/**
 * The scripts that allow service workers and do not call both halves, each
 * with what it is missing. `files` is `[{ path, text }]`.
 */
export function walksThatRaceTheFirstLoad(files) {
  const found = [];
  for (const { path, text } of files) {
    if (!isWalkScript(path) || !allowsServiceWorkers(text)) continue;
    const { tracks, waits } = firstLoadCalls(text);
    const missing = [
      tracks ? null : "trackControlledBirth(context)",
      waits ? null : "untilBornControlled(page)",
    ].filter(Boolean);
    if (missing.length > 0) found.push({ path, missing });
  }
  return found;
}
