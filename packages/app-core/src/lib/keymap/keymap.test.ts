import { describe, expect, it } from "vitest";
import { CORE_COMMANDS, FIXED_ROWS, NOP, RESERVED_KEYS } from "./commands.js";
import {
  EMPTY_KEYMAP,
  type KeymapBindings,
  type KeymapConfig,
  layBindings,
  parseStep,
  readKeymap,
  reservedReason,
} from "./config.js";
import {
  bindKey,
  conflictFor,
  defaultBindings,
  effectiveBindings,
  isChanged,
  keysFor,
  resetTarget,
  restoreKey,
  unbindKey,
} from "./effective.js";
import {
  canonicalSequence,
  keycapLabel,
  normalizeToken,
  spokenSequence,
  tokenFromPress,
} from "./notation.js";

const commands = CORE_COMMANDS;
const defaults = defaultBindings(commands);

function read(candidate: Parameters<typeof readKeymap>[0]) {
  return readKeymap(candidate, commands, defaults);
}

describe("key notation", () => {
  it("folds Shift into a printed character and spells it on a named key", () => {
    expect(tokenFromPress({ key: "G", shiftKey: true })).toBe("G");
    expect(tokenFromPress({ key: "?", shiftKey: true })).toBe("?");
    expect(tokenFromPress({ key: "Tab", shiftKey: true })).toBe("Shift+Tab");
    expect(tokenFromPress({ key: "d", ctrlKey: true })).toBe("Control+d");
    expect(tokenFromPress({ key: " " })).toBe("Space");
  });

  it("never hands the keymap a modifier, Alt, Meta or a soft-keyboard blank", () => {
    expect(tokenFromPress({ key: "Shift", shiftKey: true })).toBeNull();
    expect(tokenFromPress({ key: "k", metaKey: true })).toBeNull();
    expect(tokenFromPress({ key: "k", altKey: true })).toBeNull();
    expect(tokenFromPress({ key: "Unidentified" })).toBeNull();
  });

  it("reads the spellings older files and people write", () => {
    expect(normalizeToken("Shift+?")).toBe("?");
    expect(normalizeToken("Shift+g")).toBe("G");
    expect(normalizeToken("ctrl+d")).toBe("Control+d");
    expect(normalizeToken("esc")).toBe("Escape");
    expect(normalizeToken("pagedown")).toBe("PageDown");
    expect(canonicalSequence("  g   v ")).toBe("g v");
    expect(canonicalSequence("a b c d e")).toBeNull();
    expect(canonicalSequence("Hyper+x")).toBeNull();
  });

  it("draws keycaps and speaks sequences", () => {
    expect(keycapLabel("Control+d")).toBe("Ctrl-d");
    expect(keycapLabel("ArrowDown")).toBe("↓");
    expect(spokenSequence(["g", "v"])).toBe("g then v");
  });
});

describe("reading a keymap", () => {
  it("keeps only what differs from the defaults", () => {
    const result = read({ bindings: { j: "listing.next", w: "item.edit" } });
    expect(result.ok && result.config.bindings).toEqual({ w: "item.edit" });
  });

  it("refuses URLs, unknown commands and reserved keys whole", () => {
    expect(read({ bindings: { x: "https://evil.example/hook" } }).ok).toBe(
      false,
    );
    expect(read({ bindings: { x: "not.a.command" } }).ok).toBe(false);
    expect(read({ bindings: { Tab: "listing.next" } }).ok).toBe(false);
    expect(read({ bindings: { "g 5": "listing.next" } }).ok).toBe(false);
    expect(reservedReason("Escape")).toMatch(/fixed/);
  });

  it("leaves the browser's own tab, window and reload keys alone", () => {
    const browser = [
      "Control+Tab",
      "Control+Shift+Tab",
      "Control+PageUp",
      "Control+PageDown",
      "Control+1",
      "Control+9",
      "Control+w",
      "Control+t",
      "Control+Shift+t",
      "Control+Shift+w",
      "Control+Shift+n",
      "Control+n",
      "Control+q",
      "Control+r",
      "F5",
      "F11",
      "F12",
    ];
    for (const key of browser) {
      expect(reservedReason(key), key).toMatch(/fixed/);
      expect(read({ bindings: { [key]: "listing.next" } }).ok, key).toBe(false);
    }
    // The shipped Control defaults stay bindable.
    for (const key of ["Control+p", "Control+d", "Control+l"])
      expect(reservedReason(key), key).toBeNull();
  });

  it("ships no default on a key the browser keeps for its windows and tabs", () => {
    for (const command of CORE_COMMANDS)
      for (const sequence of command.defaults)
        expect(
          reservedReason(sequence),
          `${command.id} ${sequence}`,
        ).toBeNull();
  });

  it("discloses every fixed key in the read-only Fixed rows", () => {
    const listed = new Set(FIXED_ROWS.flatMap(([keys]) => keys.split(" / ")));
    const fixed = [...RESERVED_KEYS]
      .filter(([, reason]) => reason !== "The browser's")
      .map(([token]) => token);
    // The Menu key is one of them, beside Shift+F10 and Shift+Enter.
    expect(fixed).toContain("ContextMenu");
    for (const token of fixed) {
      if (/^[1-9]$/.test(token)) continue; // the digits are one row, "1 … 9"
      expect(listed.has(token), token).toBe(true);
    }
    expect(FIXED_ROWS.some(([keys]) => keys.startsWith("1 …"))).toBe(true);
  });

  it("never moves a key onto a command that asks before it acts", () => {
    const moved = read({ bindings: { j: "item.share" } });
    expect(moved.ok).toBe(false);
    // …but its own key may be given to something else.
    expect(read({ bindings: { x: "item.edit" } }).ok).toBe(true);
  });

  it("reads an unbind as null or nop", () => {
    const result = read({ bindings: { x: null, y: NOP } });
    expect(result.ok && result.config.bindings).toEqual({ x: NOP, y: NOP });
  });

  it("reads macros as named step lists with counts and triggers", () => {
    const result = read({
      macros: {
        triage: { on: "unlock", steps: ["listing.search", "3 listing.next"] },
      },
      bindings: { "Space t": "macro.triage" },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.config.macros.triage).toEqual({
      on: "unlock",
      steps: [
        { command: "listing.search", count: 1 },
        { command: "listing.next", count: 3 },
      ],
    });
    expect(result.config.bindings["Space t"]).toBe("macro.triage");
  });

  it("refuses a macro that could do from an event what only a person should", () => {
    const reveal = read({
      macros: { grab: { on: "unlock", steps: ["item.copy-secret"] } },
    });
    expect(reveal.ok).toBe(false);
    const trash = read({ macros: { purge: ["item.trash"] } });
    expect(trash.ok).toBe(false);
    const loop = read({
      macros: { bounce: { on: "enter:vault", steps: ["section.settings"] } },
    });
    expect(loop.ok).toBe(false);
    expect(read({ bindings: { q: "macro.missing" } }).ok).toBe(false);
  });

  it("never lets an Object.prototype name stand for a macro", () => {
    const names = ["constructor", "__proto__", "toString", "hasOwnProperty"];
    for (const name of [...names, "valueOf"]) {
      const refused = read({ bindings: { q: `macro.${name}` } });
      expect(refused).toEqual({ ok: false, message: `No macro "${name}".` });
      const inContext = read({ contexts: { vault: { d: `macro.${name}` } } });
      expect(inContext.ok).toBe(false);
    }
    const layered = layBindings(
      new Map([["q", "macro.constructor"]]),
      { q: "macro.constructor" },
      {},
    );
    expect(layered.has("q")).toBe(false);
  });

  it("stores a macro named like a prototype member safely", () => {
    const kept = read({
      macros: { constructor: ["listing.first"] },
      bindings: { "Space c": "macro.constructor" },
    });
    expect(kept.ok && kept.config.bindings["Space c"]).toBe(
      "macro.constructor",
    );
    const forged = JSON.parse('{"macros":{"__proto__":["listing.first"]}}');
    expect(read(forged).ok).toBe(false);
    const empty = read({ macros: {} });
    expect(empty.ok && Object.hasOwn(empty.config.macros, "toString")).toBe(
      false,
    );
    expect(empty.ok && "toString" in empty.config.macros).toBe(false);
  });

  it("parses steps the way vim writes counts", () => {
    expect(parseStep("3 listing.next")).toEqual({
      command: "listing.next",
      count: 3,
    });
    expect(parseStep("listing.next")).toEqual({
      command: "listing.next",
      count: 1,
    });
    expect(parseStep("rm -rf /")).toBeNull();
  });
});

describe("the keymap in force", () => {
  const with_ = (bindings: KeymapBindings): KeymapConfig => ({
    ...EMPTY_KEYMAP,
    bindings,
  });

  it("strikes an unbound default and shows it, rather than hiding it", () => {
    const config = unbindKey(EMPTY_KEYMAP, commands, "j");
    expect(effectiveBindings(config, commands).has("j")).toBe(false);
    expect(keysFor("listing.next", config, commands)).toContainEqual({
      sequence: "j",
      source: "removed",
    });
    expect(restoreKey(config, "j").bindings).toEqual({});
  });

  it("replaces: whatever held the key loses it", () => {
    const config = bindKey(EMPTY_KEYMAP, commands, "x", "item.edit");
    const map = effectiveBindings(config, commands);
    expect(map.get("x")).toBe("item.edit");
    expect(conflictFor("x", "item.new", map)).toEqual({
      kind: "taken",
      target: "item.edit",
    });
  });

  it("swaps: the holder takes the re-recorded key in exchange", () => {
    const config = bindKey(EMPTY_KEYMAP, commands, "k", "listing.next", {
      previous: "j",
      mode: "swap",
    });
    const map = effectiveBindings(config, commands);
    expect(map.get("k")).toBe("listing.next");
    expect(map.get("j")).toBe("listing.previous");
  });

  it("reports a shared prefix, which makes the shorter key wait", () => {
    const map = effectiveBindings(with_({ g: "help.keymap" }), commands);
    const conflict = conflictFor("g", "help.keymap", map);
    expect(conflict.kind).toBe("prefix");
  });

  it("switches character keys off and keeps Control and named keys", () => {
    const map = effectiveBindings(
      { ...EMPTY_KEYMAP, singleKeys: false },
      commands,
    );
    expect(map.has("j")).toBe(false);
    expect(map.has("g v")).toBe(false);
    expect(map.get("ArrowDown")).toBe("listing.next");
    expect(map.get("Control+l")).toBe("command.palette");
  });

  it("resets one command without touching another's changes", () => {
    let config = bindKey(EMPTY_KEYMAP, commands, "w", "item.edit");
    config = unbindKey(config, commands, "e");
    config = bindKey(config, commands, "q", "help.keymap");
    const reset = resetTarget(config, commands, "item.edit");
    expect(reset.bindings).toEqual({ q: "help.keymap" });
  });

  it("resets a command whose default key was given to another command", () => {
    // "Take x": Edit holds x, so Move to trash is changed and offers Reset.
    const taken = bindKey(EMPTY_KEYMAP, commands, "x", "item.edit");
    expect(isChanged("item.trash", taken, commands)).toBe(true);
    const reset = resetTarget(taken, commands, "item.trash");
    expect(reset.bindings).toEqual({});
    expect(isChanged("item.trash", reset, commands)).toBe(false);
    const map = effectiveBindings(reset, commands);
    expect(map.get("x")).toBe("item.trash");
    // …and the holder loses the key it had taken.
    expect(keysFor("item.edit", reset, commands)).toEqual([
      { sequence: "e", source: "default" },
    ]);
  });
});
