// The commands that run a unit-test plan (ci-scoped-tests.mjs), as data, so
// what CI runs for a diff is something a test can read.

import { resolve } from "node:path";

/**
 * @param {string} root the repository root
 * @param {string[]} packages every affected package, for the plan-less fallback
 * @param {ReturnType<typeof import("./ci-scoped-tests.mjs").planUnitTests> | undefined} plans
 *   undefined when the diff could not be read: every package runs whole
 * @returns {{ command: string, args: string[], note?: string }[]}
 */
export function unitTestCommands(root, packages, plans) {
  const whole =
    plans === undefined
      ? packages
      : plans.filter((entry) => entry.mode === "full").map((e) => e.name);
  const commands = [];
  if (whole.length > 0) {
    commands.push({
      command: "pnpm",
      args: [
        "exec",
        "turbo",
        "run",
        "test",
        "--concurrency=4",
        ...whole.map((name) => `--filter=${name}`),
      ],
    });
  }
  for (const entry of plans ?? []) {
    if (entry.mode === "scoped") commands.push(...scopedCommands(root, entry));
  }
  return commands;
}

function scopedCommands(root, entry) {
  const vitest = ["--filter", entry.name, "exec", "vitest"];
  const commands = [];
  if (entry.related.length > 0) {
    commands.push({
      command: "pnpm",
      args: [
        ...vitest,
        "related",
        ...entry.related.map((path) => resolve(root, path)),
        "--run",
        "--passWithNoTests",
      ],
    });
  }
  const named = [...new Set([...entry.structural, ...entry.hubTests])];
  if (named.length > 0) {
    commands.push({
      command: "pnpm",
      args: [...vitest, "run", ...named, "--passWithNoTests"],
      note:
        entry.hubs.length > 0
          ? `${entry.name} follows ${entry.hubs.join(", ")} ${entry.hubTests.length} tests deep, not the whole suite`
          : undefined,
    });
  }
  if (entry.extra !== undefined && entry.extraRuns) {
    commands.push({
      command: "pnpm",
      args: ["--filter", entry.name, "exec", "sh", "-c", entry.extra],
    });
  }
  return commands;
}

/** One line per package: how its tests run and why. */
export function describePlans(plans) {
  return (plans ?? []).map(
    (entry) =>
      `unit tests: ${entry.name} ${entry.mode}${entry.why ? ` (${entry.why})` : ""}`,
  );
}
