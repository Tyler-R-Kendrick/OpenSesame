/**
 * Change the built service worker's shell revision and nothing else.
 *
 * The release id is the `index.html` revision (`src/sw/release.ts`). A walk
 * that serves this bumped script is a new release to a page that already
 * booted, which is the mismatch `plan-sync.ts` reloads for.
 */

const ALPHABET =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-";

/** @param {string | Buffer} source */
export function bumpShellRevision(source) {
  const text = Buffer.isBuffer(source)
    ? source.toString("utf8")
    : String(source);
  // The minified worker also mentions index.html inside functions. Only the
  // precache object whose url is the shell carries the release id.
  let body = null;
  let revision = null;
  for (const match of text.matchAll(/\{[^{}]*\}/g)) {
    if (!/"url"\s*:\s*"index\.html"/.test(match[0])) continue;
    const found = /("revision"\s*:\s*")([A-Za-z0-9_-]{1,64})(")/.exec(match[0]);
    if (!found) continue;
    body = match[0];
    revision = found;
    break;
  }
  if (!body || !revision) {
    throw new Error("index.html revision not found in sw.js");
  }
  const current = revision[2];
  const last = current.at(-1) ?? "";
  const replacement = [...ALPHABET].find((char) => char !== last);
  if (!replacement) throw new Error("shell revision has no unused alphabet");
  const next = `${current.slice(0, -1)}${replacement}`;
  const nextBody = body.replace(
    revision[0],
    `${revision[1]}${next}${revision[3]}`,
  );
  return { source: text.replace(body, nextBody), from: current, to: next };
}
