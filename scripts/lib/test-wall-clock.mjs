// Detectors for tests whose result depends on the real clock. Kept out of the
// test file that runs them (Biome forbids exports from a test file) so the
// detectors can be exercised on small examples as well as on the workspace.

import { readdirSync } from "node:fs";
import { join } from "node:path";

/** A test file that pins its own clock to a fixed instant. */
export const FIXED_NOW = /\bNOW\s*=\s*new Date\(\s*"20\d\d-/u;

const TEST_FILE = /(\.test\.tsx?|\.test\.mjs|__tests__\/[^/]+\.ts)$/u;

/** Every test source file under `dir`, skipping dependencies and dot folders. */
export function testSources(dir, found = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) testSources(path, found);
    else if (TEST_FILE.test(path.replaceAll("\\", "/"))) found.push(path);
  }
  return found;
}

/** The text of each call that starts with `opener`, to its matching parenthesis. */
export function callsStarting(source, opener) {
  const calls = [];
  for (const match of source.matchAll(opener)) {
    let depth = 1;
    let end = match.index + match[0].length;
    while (end < source.length && depth > 0) {
      if (source[end] === "(") depth += 1;
      else if (source[end] === ")") depth -= 1;
      end += 1;
    }
    calls.push(source.slice(match.index, end));
  }
  return calls;
}

/** `outbox.append(...)` calls that leave `availableAt` to the wall clock. */
export function outboxAppendCalls(source) {
  return callsStarting(source, /\boutbox\.append\(/gu);
}

/**
 * A constant that claims never to expire, to last forever, or to sit far in the
 * future, but is a calendar date. The date arrives, and everything that compares
 * it with a clock it does not own goes red that morning (wallet's
 * interaction-handoff suite named 2030-01-01 "NEVER_EXPIRES").
 */
export const FOREVER_DATE =
  /\b(?:const|let)\s+\w*(?:NEVER|FOREVER|FAR_?FUTURE|DISTANT|NO_EXPIR)\w*\s*(?::[^=]+)?=\s*(?:new Date\(\s*)?["'`]20\d\d-/iu;

const AWAITED_CALL = /\bawait waitFor\(/gu;
const UI_READ =
  /^\s*(?:expect\(\s*)?(?:const \w+ = )?(?:screen|dialog|sheet\(\)|within\([^)]*\))\.(?:getBy|getAllBy)\w*\(/u;

/**
 * `await waitFor(() => expect(mock).toHaveBeenCalled...)` followed at once by a
 * synchronous read of the screen.
 *
 * A mock being called is the question being asked, not the answer being drawn:
 * whatever the call's promise resolves into reaches the screen later, after the
 * test has already read it. It passes where promises settle in the same turn
 * and fails on a loaded runner (Unlock methods' QR and "Code sent" reads did).
 * Wait for the thing that is read: `await screen.findBy...`, or `waitFor` on it.
 */
export function readsBeforeTheAnswer(source) {
  const found = [];
  for (const match of source.matchAll(AWAITED_CALL)) {
    const [call] = callsStarting(
      source.slice(match.index, match.index + 2000),
      /\bawait waitFor\(/gu,
    );
    const asksOnly =
      /\.toHaveBeenCalled/u.test(call) &&
      !/\b(?:getBy|findBy|queryBy)/u.test(call);
    if (!asksOnly) continue;
    const rest = source.slice(match.index + call.length).replace(/^;/u, "");
    const next = rest
      .split("\n")
      .find((line, index) => index > 0 && line.trim() !== "");
    if (next !== undefined && UI_READ.test(next)) {
      found.push(
        `${call.replace(/\s+/gu, " ").slice(0, 80)} -> ${next.trim()}`,
      );
    }
  }
  return found;
}
