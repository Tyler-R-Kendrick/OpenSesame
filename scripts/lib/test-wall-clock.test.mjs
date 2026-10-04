import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { repoRootFromHere } from "./ci-affected-graph.mjs";

/**
 * A test that fixes its clock must not let the wall clock decide anything.
 *
 * `outbox.append` stamps `availableAt` with `new Date()` unless told otherwise.
 * A suite that drives the cleanup tick with a fixed `NOW` and appends events
 * without `availableAt` passes only while the wall clock is before `NOW`, and
 * goes red for everybody the moment it is not: that is how identity-worker's
 * Web Push suite went 8/8 red on main at 12:00 UTC on the day it was written,
 * after a green merge. The tick's clock is the one that says when an event is
 * due, so the event must be stamped with it.
 */

const FIXED_NOW = /\bNOW\s*=\s*new Date\(\s*"20\d\d-/u;

function testSources(dir, found = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) testSources(path, found);
    else if (
      /(\.test\.ts|__tests__\/[^/]+\.ts)$/u.test(path.replaceAll("\\", "/"))
    )
      found.push(path);
  }
  return found;
}

/** The text of each `outbox.append(...)` call, to its matching parenthesis. */
export function outboxAppendCalls(source) {
  const calls = [];
  for (const match of source.matchAll(/\boutbox\.append\(/gu)) {
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

describe("a test with a fixed clock stamps the events it appends", () => {
  it("recognises the call that was left to the wall clock", () => {
    const bad = `await repos.outbox.append({ id: "x", payload: { a: f(1) } });`;
    const good = `await repos.outbox.append({ id: "x", availableAt: NOW, payload: {} });`;
    expect(outboxAppendCalls(bad)[0]).not.toContain("availableAt");
    expect(outboxAppendCalls(good)[0]).toContain("availableAt");
  });

  it("holds across the workspace's tests", () => {
    const root = repoRootFromHere();
    const offenders = [];
    for (const base of ["packages", "apps"]) {
      for (const file of testSources(join(root, base))) {
        const source = readFileSync(file, "utf8");
        if (!FIXED_NOW.test(source)) continue;
        for (const call of outboxAppendCalls(source)) {
          if (!call.includes("availableAt")) {
            offenders.push(
              `${file.slice(root.length + 1)}: ${call.slice(0, 60)}`,
            );
          }
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
