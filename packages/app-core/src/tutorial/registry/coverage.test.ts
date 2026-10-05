import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { keymapCommands } from "../../lib/keymap/commands.js";
import { mergedGuideTargets } from "./catalog.js";
import { COVERAGE_EXEMPT } from "./coverage-ledger.js";
import { guideGoal, mergedGuideGoals } from "./goals.js";
import { KEYMAP_TUTORIALS } from "./keymap-tutorials.js";
import { registerTutorialRealm } from "./optional-tutorials.test-support.js";

/**
 * Every control and every key is taught by a tutorial, or the debt ledger
 * names it with a reason (ADR 0163 §6). The ledger only falls.
 */
let revoke = () => {};
beforeAll(() => {
  revoke = registerTutorialRealm();
});
afterAll(() => revoke());

function pointedAt(): ReadonlySet<string> {
  const pointed = new Set<string>();
  for (const goal of mergedGuideGoals()) {
    for (const match of goal.guide.matchAll(
      /(?:focus|wait target) "([^"]+)"/g,
    )) {
      if (match[1]) pointed.add(match[1]);
    }
  }
  return pointed;
}

/** Each key command and the tutorial that teaches it. */
const TUTORIAL_OF_KEY = new Map(Object.entries(KEYMAP_TUTORIALS));

const keyIsTaught = (id: string): boolean => {
  const entry = TUTORIAL_OF_KEY.get(id);
  if (!entry) return false;
  const goal = guideGoal(entry.goal);
  return goal?.guide.includes(entry.says) === true;
};

describe("tutorial coverage", () => {
  it("teaches every control a guide can point at, or names the debt", () => {
    const pointed = pointedAt();
    const missing = mergedGuideTargets()
      .map((target) => target.id)
      .filter((id) => !pointed.has(id) && !(`target:${id}` in COVERAGE_EXEMPT));
    expect(missing, "controls with no tutorial and no ledger line").toEqual([]);
  });

  it("teaches every key the keymap binds, or names the debt", () => {
    const missing = keymapCommands()
      .map((command) => command.id)
      .filter((id) => !keyIsTaught(id) && !(`key:${id}` in COVERAGE_EXEMPT));
    expect(missing, "keys with no tutorial and no ledger line").toEqual([]);
  });

  it("points every key tutorial at a goal that says it", () => {
    for (const [id, entry] of Object.entries(KEYMAP_TUTORIALS)) {
      const goal = guideGoal(entry.goal);
      expect(goal, `${id}: ${entry.goal} is not a tutorial`).not.toBeNull();
      expect(
        goal?.guide,
        `${id}: ${entry.goal} never says "${entry.says}"`,
      ).toContain(entry.says);
    }
  });

  it("keeps no ledger line for a control that is taught or gone", () => {
    const pointed = pointedAt();
    const targets = new Set(mergedGuideTargets().map((target) => target.id));
    const keys = new Set(keymapCommands().map((command) => command.id));
    const stale: string[] = [];
    for (const [line, reason] of Object.entries(COVERAGE_EXEMPT)) {
      expect(reason.trim(), `${line} has no reason`).not.toBe("");
      const [kind, id = ""] = line.split(/:(.+)/);
      if (kind === "target") {
        if (!targets.has(id) || pointed.has(id)) stale.push(line);
      } else if (kind === "key") {
        if (!keys.has(id) || keyIsTaught(id)) stale.push(line);
      } else stale.push(line);
    }
    expect(stale, "delete these ledger lines: they are taught or gone").toEqual(
      [],
    );
  });
});
