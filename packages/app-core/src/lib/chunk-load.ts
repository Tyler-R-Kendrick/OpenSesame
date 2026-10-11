/**
 * A lazy chunk that cannot be fetched.
 *
 * A tab left open across a deploy still names the hashed files of the build it
 * loaded, and the host has since replaced them: the next `import()` of one that
 * was not fetched yet answers 404, and the browser says so in its own words.
 * Those words name a URL and no remedy, so a failure that is really "this page
 * is out of date" is told as that.
 */

/** Chrome, Firefox and Safari each phrase the same failure their own way. */
const CHUNK_LOAD_FAILURE =
  /Failed to fetch dynamically imported module|error loading dynamically imported module|Importing a module script failed|Loading (?:CSS )?chunk \S+ failed/iu;

/** What the person is told: the page, not their file or their key, is what failed. */
export const STALE_BUILD =
  "This page is out of date, so part of it could not load. Reload it, then try again.";

/** Whether `caught` is a browser's refusal to fetch a lazily loaded chunk. */
export function isChunkLoadFailure<Thrown>(caught: Thrown): boolean {
  return caught instanceof Error && CHUNK_LOAD_FAILURE.test(caught.message);
}
