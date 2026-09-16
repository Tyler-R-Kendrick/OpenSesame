/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { kvDelete, kvSet } from "./kv.js";
import {
  THEME_KEY,
  applyTheme,
  bootstrapTheme,
  cycleTheme,
  hasStoredTheme,
  loadTheme,
  setTheme,
} from "./theme.js";

function clearTheme(): void {
  kvDelete(THEME_KEY);
  document.documentElement.removeAttribute("data-theme");
  bootstrapTheme();
}

describe("theme", () => {
  beforeEach(() => {
    clearTheme();
  });

  afterEach(() => {
    clearTheme();
  });

  it("defaults to system and clears data-theme", () => {
    expect(loadTheme()).toBe("system");
    expect(hasStoredTheme()).toBe(false);
    applyTheme("system");
    expect(document.documentElement.hasAttribute("data-theme")).toBe(false);
  });

  it("persists day and night in plaintext kv", () => {
    setTheme("dark");
    expect(hasStoredTheme()).toBe(true);
    expect(loadTheme()).toBe("dark");
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
    bootstrapTheme();
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");

    setTheme("light");
    expect(document.documentElement.getAttribute("data-theme")).toBe("light");
  });

  it("cycles Day → Night → System", () => {
    setTheme("light");
    expect(cycleTheme()).toBe("dark");
    expect(cycleTheme()).toBe("system");
    expect(cycleTheme()).toBe("light");
  });

  it("treats a junk stored value as system", () => {
    kvSet(THEME_KEY, "neon");
    bootstrapTheme();
    expect(loadTheme()).toBe("system");
    expect(hasStoredTheme()).toBe(false);
  });
});
