import { dropPack, packEntries } from "@opensesame/vault-item-types";
import { beforeEach, describe, expect, it } from "vitest";
import type { PackSnapshot } from "../../lib/type-packs/state.js";
import {
  formatBytes,
  packGroups,
  packTally,
  transitionSentence,
} from "./item-type-packs-model.js";

// The suite loads every pack; the list is about packs that are off.
beforeEach(() => {
  for (const entry of packEntries()) dropPack(entry.id);
});

const base: PackSnapshot = {
  status: {},
  counts: new Map(),
  pending: 0,
  settled: 0,
  revision: 0,
};

const rowOf = (
  snapshot: PackSnapshot,
  id: string,
  managed = new Set<string>(),
) =>
  packGroups(snapshot, { managed })
    .flatMap((group) => group.rows)
    .find((row) => row.id === id);

describe("the item-type list", () => {
  it("groups the 18 packs by what they are for, in the order people reach for them", () => {
    const groups = packGroups(base);
    expect(groups.map((group) => group.label)).toEqual([
      "Access",
      "Developer",
      "Finance",
      "Identity",
      "Documents",
    ]);
    expect(groups.flatMap((group) => group.rows)).toHaveLength(18);
  });

  it("says what each costs to switch on", () => {
    expect(rowOf(base, "login")?.facts).toMatch(/^\d+ fields? · \d\.\d KB$/);
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(2048)).toBe("2.0 KB");
  });

  it("puts a switch on a pack that is off, unchecked", () => {
    expect(rowOf(base, "login")).toMatchObject({
      control: "switch",
      checked: false,
      busy: false,
      phase: "off",
    });
  });

  it("shows a pack on its way as checked and busy", () => {
    for (const phase of ["queued", "downloading", "installing"] as const) {
      const row = rowOf({ ...base, status: { login: { phase } } }, "login");
      expect(row).toMatchObject({
        checked: true,
        busy: true,
        control: "switch",
      });
    }
  });

  it("shows a failure as off with its reason", () => {
    const row = rowOf(
      { ...base, status: { login: { phase: "failed", reason: "Offline." } } },
      "login",
    );
    expect(row).toMatchObject({ checked: false, reason: "Offline." });
    expect(row?.sentence).toBe("Login did not install: Offline.");
  });

  it("takes the switch away from a type the vault holds items of", () => {
    const row = rowOf(
      {
        ...base,
        status: { card: { phase: "on" } },
        counts: new Map([["card", 2]]),
      },
      "card",
    );
    expect(row).toMatchObject({ control: "held", checked: true, held: 2 });
    expect(row?.sentence).toBe("Card stays on: this vault has 2 items of it.");
  });

  it("takes the switch away from a type a capability put on", () => {
    const row = rowOf(
      { ...base, status: { note: { phase: "on" } } },
      "note",
      new Set(["note"]),
    );
    expect(row?.control).toBe("managed");
  });

  it("filters by every word, anywhere in what a person might remember", () => {
    const rows = (query: string) =>
      packGroups(base, { query }).flatMap((group) =>
        group.rows.map((r) => r.id),
      );
    expect(rows("wi-fi")).toEqual(["wifi"]);
    expect(rows(".ssh")).toContain("ssh-key");
    expect(rows("finance card")).toEqual(["card"]);
    expect(rows("zzzz")).toEqual([]);
  });

  it("tallies what is on", () => {
    expect(packTally(base)).toBe("0 of 18 on");
    expect(
      packTally({
        ...base,
        status: { login: { phase: "on" }, card: { phase: "installing" } },
      }),
    ).toBe("1 of 18 on");
  });
});

describe("announcing a change", () => {
  it("speaks arrivals, failures, removals and cancellations only", () => {
    expect(transitionSentence("Login", "installing", "on", null)).toBe(
      "Login installed.",
    );
    expect(transitionSentence("Login", "installing", "failed", "Offline")).toBe(
      "Login did not install: Offline.",
    );
    expect(transitionSentence("Login", "on", "off", null)).toBe(
      "Login removed.",
    );
    expect(transitionSentence("Login", "downloading", "off", null)).toBe(
      "Login cancelled.",
    );
    expect(transitionSentence("Login", "off", "queued", null)).toBeNull();
    expect(transitionSentence("Login", "on", "on", null)).toBeNull();
  });
});
