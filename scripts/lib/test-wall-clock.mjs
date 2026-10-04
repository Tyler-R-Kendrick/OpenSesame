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
