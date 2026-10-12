import { describe, expect, it } from "vitest";
import {
  type SlashSection,
  slashSections,
  slashSuggestions,
  suggestionKey,
} from "./slash.js";

const SECTIONS: readonly SlashSection[] = [
  { path: "/vault", label: "Vault" },
  { path: "/settings", label: "Settings" },
  { path: "/wallet", label: "Wallet" },
  { path: "/identity?view=people", label: "Identity · People" },
];

describe("slashSuggestions", () => {
  it("lists destinations and verbs when the field is just a slash", () => {
    const rows = slashSuggestions("/", SECTIONS, []);
    expect(rows.map((row) => row.insert.trim())).toEqual([
      "/vault",
      "/settings",
      "/help",
      "/search",
      "/open",
      "/copy password",
      "/wallet",
      "/identity?view=people",
    ]);
    expect(rows.find((row) => row.insert === "/vault")?.run).toBe(true);
    expect(rows.find((row) => row.insert === "/search ")?.run).toBe(false);
  });

  it("narrows by the typed command", () => {
    const rows = slashSuggestions("/w", SECTIONS, ["Wifi"]);
    expect(rows.map((row) => row.label)).toEqual(["Wallet"]);
    expect(
      slashSuggestions("/copy p", SECTIONS, []).map((row) => row.insert),
    ).toEqual(["/copy password "]);
  });

  it("completes item names after open/copy, never a secret", () => {
    const rows = slashSuggestions("/open g", SECTIONS, [
      "GitHub",
      "Google",
      "Bank",
    ]);
    expect(rows.map((row) => row.insert)).toEqual([
      "/open GitHub",
      "/open Google",
    ]);
    expect(
      rows.every((row) => row.label === row.insert.slice("/open ".length)),
    ).toBe(true);
    expect(JSON.stringify(rows)).not.toContain("password");
  });

  it("answers `/?` as search, and offers no names after it: the listing is the completion", () => {
    expect(slashSuggestions("/?", SECTIONS, []).map((row) => row.id)).toEqual([
      "search",
    ]);
    for (const typed of ["/? g", "/search g", "/? "]) {
      expect(slashSuggestions(typed, SECTIONS, ["GitHub", "Bank"])).toEqual([]);
    }
  });

  it("canonicalizes a copy-field alias before naming items", () => {
    const rows = slashSuggestions("/copy pass ", SECTIONS, ["GitHub"]);
    expect(rows).toEqual([
      {
        id: "copy-password:0:GitHub",
        insert: "/copy password GitHub",
        label: "GitHub",
        run: true,
      },
    ]);
  });

  it("says nothing for an ordinary sentence", () => {
    expect(slashSuggestions("go to vault", SECTIONS, ["GitHub"])).toEqual([]);
  });

  it("offers the claim ceremony, and /drop as its alias", () => {
    const sections = slashSections([]);
    expect(
      slashSuggestions("/", sections, []).map((row) => row.insert.trim()),
    ).toContain("/claim");
    expect(
      slashSuggestions("/drop", sections, []).map((row) => row.insert),
    ).toEqual(["/claim"]);
    expect(slashSuggestions("/claim", sections, [])[0]).toMatchObject({
      insert: "/claim",
      label: "Claim",
      run: true,
    });
    expect(
      slashSuggestions("/", sections, []).map((row) => row.insert.trim()),
    ).toContain("/join");
    expect(slashSuggestions("/join", sections, [])[0]).toMatchObject({
      insert: "/join",
      label: "Join",
      run: true,
    });
  });
});

describe("slashSections", () => {
  it("keeps the core destinations and drops a path the plan refuses", () => {
    const rows = slashSections(
      [
        { path: "/wallet", label: "Wallet" },
        { path: "/vault", label: "Vault again" },
      ],
      (path) => path !== "/wallet",
    );
    expect(rows).toEqual([
      { path: "/vault", label: "Vault" },
      { path: "/settings", label: "Settings" },
      { path: "/claim", label: "Claim" },
      { path: "/join", label: "Join" },
    ]);
  });
});

describe("suggestionKey", () => {
  const rows = slashSuggestions("/", SECTIONS, []);

  it("moves, accepts, and closes only while the list is open", () => {
    expect(suggestionKey("ArrowDown", true, rows, 0)).toEqual({
      type: "move",
      index: 1,
    });
    expect(suggestionKey("ArrowUp", true, rows, 0)).toEqual({
      type: "move",
      index: rows.length - 1,
    });
    expect(suggestionKey("Enter", true, rows, 2)).toEqual({
      type: "accept",
      suggestion: rows[2],
    });
    expect(suggestionKey("Escape", true, rows, 0)).toEqual({ type: "close" });
    expect(suggestionKey("Enter", false, rows, 0)).toEqual({ type: "none" });
  });
});
