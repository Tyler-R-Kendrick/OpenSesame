/** @vitest-environment jsdom */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { matchMediaFor } from "../lib/use-narrow.test-fake.js";
import { EmptyTip, type EmptyTipKey, isEmptyTipKey } from "./EmptyTip.js";

const SRC = join(import.meta.dirname, "..");

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true, recursive: true })
    .filter((f) => f.isFile() && /\.tsx$/.test(f.name))
    .filter((f) => !/\.test\.tsx$/.test(f.name))
    .map((f) => join(f.parentPath, f.name));
}

/** Every `<EmptyTip …>` opening tag in the app, with the file it is in. */
type CallSite = { file: string; tag: string };

function callSites(): CallSite[] {
  const found: CallSite[] = [];
  for (const file of sources(SRC)) {
    const text = readFileSync(file, "utf8");
    for (const m of text.matchAll(/<EmptyTip\b[^>]*?\/?>/gs)) {
      found.push({ file, tag: m[0] });
    }
  }
  return found;
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("every EmptyTip call site, under a finger", () => {
  it("names its tip or says it is not about keys", () => {
    // A tip handed as children is matched by nothing: it would be keys-only
    // and vanish on a phone with no word to say in its place.
    const sites = callSites();
    expect(sites.length).toBeGreaterThan(0);
    for (const { file, tag } of sites) {
      expect(tag, file).toMatch(/\btip=|\bkeys=\{false\}/);
    }
  });

  it("draws a touch voice for each tip a call site names", () => {
    vi.stubGlobal("matchMedia", matchMediaFor(true));
    const named = new Set<EmptyTipKey>();
    for (const { tag } of callSites()) {
      for (const m of tag.matchAll(/"([A-Za-z]+)"/g)) {
        const key = m[1];
        if (key !== undefined && isEmptyTipKey(key)) named.add(key);
      }
    }
    expect(named.size).toBeGreaterThanOrEqual(5);
    for (const key of named) {
      render(<EmptyTip tip={key} />);
      const note = screen.getByRole("note");
      // Never the keys-only class, which CSS hides under a coarse pointer.
      expect(note.className).not.toContain("empty__tip--keys");
      expect(
        note.querySelector(".empty__tip-touch")?.textContent?.length,
        key,
      ).toBeGreaterThan(0);
      cleanup();
    }
  });
});
