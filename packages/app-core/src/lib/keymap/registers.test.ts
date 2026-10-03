import { describe, expect, it } from "vitest";
import {
  CORE_COMMANDS,
  GROUP_ORDER,
  MACRO_PREFIX,
  REGISTER_RECORD,
  REGISTER_REPLAY,
  commandById,
} from "./commands.js";
import {
  EMPTY_KEYMAP,
  MACRO_LIMITS,
  readKeymap,
  stepProblem,
} from "./config.js";
import { defaultBindings, effectiveBindings } from "./effective.js";
import {
  appendMacroRun,
  appendRecorded,
  isRegisterCommand,
  registerMacroName,
  registerOf,
  withRecording,
} from "./registers.js";

const commands = CORE_COMMANDS;
const defaults = defaultBindings(commands);

describe("the register commands", () => {
  it("are catalogue rows on q and @, in their own group, never a macro target", () => {
    const record = commandById(REGISTER_RECORD, commands);
    const replay = commandById(REGISTER_REPLAY, commands);
    expect(record).toMatchObject({ group: "macros", kind: "navigate" });
    expect(record?.defaults).toEqual(["q"]);
    expect(replay).toMatchObject({ group: "macros", counts: true });
    expect(replay?.defaults).toEqual(["@"]);
    expect(GROUP_ORDER).toContain("macros");
    expect(REGISTER_RECORD.startsWith(MACRO_PREFIX)).toBe(false);
    expect(isRegisterCommand(REGISTER_REPLAY)).toBe(true);
    expect(isRegisterCommand("listing.next")).toBe(false);
  });

  it("can be moved to another key like every other command", () => {
    const read = readKeymap(
      { bindings: { Q: REGISTER_RECORD, q: "nop" } },
      commands,
      defaults,
    );
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    const map = effectiveBindings(read.config, commands);
    expect(map.get("Q")).toBe(REGISTER_RECORD);
    expect(map.has("q")).toBe(false);
  });

  it("are refused as a step, from a key and from an event alike", () => {
    for (const command of [REGISTER_RECORD, REGISTER_REPLAY]) {
      const step = { command, count: 1 };
      expect(stepProblem(step, undefined, commands)).toMatch(/register/);
      expect(stepProblem(step, "unlock", commands)).toMatch(/register/);
    }
    const read = readKeymap(
      { macros: { loop: { on: "unlock", steps: [REGISTER_REPLAY] } } },
      commands,
      defaults,
    );
    expect(read.ok).toBe(false);
  });
});

describe("a recording", () => {
  it("names its register a–z and nothing else", () => {
    expect(registerOf("a")).toBe("a");
    expect(registerOf("z")).toBe("z");
    expect(registerOf("A")).toBeNull();
    expect(registerOf("1")).toBeNull();
    expect(registerOf("Space")).toBeNull();
    expect(registerMacroName("a")).toBe("q-a");
  });

  it("folds a repeat into the step before it, but never two row picks", () => {
    let steps = appendRecorded([], { command: "listing.next", count: 1 });
    steps = appendRecorded(steps, { command: "listing.next", count: 2 });
    steps = appendRecorded(steps, { command: "listing.first", count: 1 });
    steps = appendRecorded(steps, { command: "listing.first", count: 1 });
    expect(steps).toEqual([
      { command: "listing.next", count: 3 },
      { command: "listing.first", count: 1 },
      { command: "listing.first", count: 1 },
    ]);
  });

  it("stays inside a macro's limits", () => {
    let steps = appendRecorded([], { command: "listing.next", count: 500 });
    expect(steps).toEqual([
      { command: "listing.next", count: MACRO_LIMITS.count },
    ]);
    steps = appendRecorded(steps, { command: "listing.next", count: 1 });
    expect(steps).toHaveLength(2);
    for (let index = 0; index < MACRO_LIMITS.steps * 2; index++) {
      const command = index % 2 ? "listing.next" : "listing.previous";
      steps = appendRecorded(steps, { command, count: 1 });
    }
    expect(steps).toHaveLength(MACRO_LIMITS.steps);
  });

  it("writes a replayed macro's steps in, once per count", () => {
    const steps = appendMacroRun(
      [],
      { steps: [{ command: "listing.last", count: 1 }] },
      2,
    );
    expect(steps).toEqual([
      { command: "listing.last", count: 1 },
      { command: "listing.last", count: 1 },
    ]);
  });

  it("is kept as q-<register>, replacing an older one, and an empty one keeps nothing", () => {
    const older = withRecording(EMPTY_KEYMAP, "a", [
      { command: "listing.next", count: 1 },
    ]);
    expect(older?.macros["q-a"]).toEqual({
      steps: [{ command: "listing.next", count: 1 }],
    });
    if (older === null) return;
    const newer = withRecording(older, "a", [
      { command: "listing.last", count: 1 },
    ]);
    expect(newer?.macros["q-a"]?.steps).toEqual([
      { command: "listing.last", count: 1 },
    ]);
    expect(withRecording(older, "b", [])).toBeNull();
    const read = readKeymap(
      { macros: { "q-a": ["listing.last"] } },
      commands,
      defaults,
    );
    expect(read.ok).toBe(true);
  });
});
