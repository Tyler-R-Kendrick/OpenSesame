/** @vitest-environment jsdom */
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  WORDMARK,
  WORDMARK_CIPHER,
  WORDMARK_FRAME_MS,
  WORDMARK_MAX_STEPS,
  WORDMARK_MIN_STEPS,
  Wordmark,
  cipherReel,
  wordmarkSeams,
} from "./Wordmark.js";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("cipherReel", () => {
  it("is a hex track that locks on the plaintext letter", () => {
    const reel = cipherReel(0, "o", WORDMARK_MAX_STEPS);
    expect(reel).toHaveLength(WORDMARK_MAX_STEPS + 1);
    expect(reel.endsWith("o")).toBe(true);
    expect(
      [...reel.slice(0, -1)].every((glyph) => WORDMARK_CIPHER.includes(glyph)),
    ).toBe(true);
  });

  it("is deterministic per slot", () => {
    expect(cipherReel(3, "n", 8)).toBe(cipherReel(3, "n", 8));
    expect(cipherReel(0, "o", 8)).not.toBe(cipherReel(1, "p", 8));
  });
});

describe("Wordmark", () => {
  beforeEach(() => {
    wordmarkSeams.revealed = false;
  });

  it("settles at once on a second mount in the same session", () => {
    const first = render(<Wordmark />);
    expect(first.container.querySelector(".wordmark--settled")).toBeNull();
    first.unmount();
    const second = render(<Wordmark />);
    expect(second.container.querySelector(".wordmark--settled")).toBeTruthy();
    expect(
      second.container.querySelector("canvas.cipher-wordmark__canvas"),
    ).toBeTruthy();
  });

  it("replays the decrypt when asked, then leaves later mounts settled", () => {
    const first = render(<Wordmark />);
    first.unmount();
    const replayed = render(<Wordmark replay />);
    expect(replayed.container.querySelector(".wordmark--settled")).toBeNull();
    replayed.unmount();
    const later = render(<Wordmark />);
    expect(later.container.querySelector(".wordmark--settled")).toBeTruthy();
  });

  it("publishes staggered slot timings for verify", () => {
    vi.spyOn(Math, "random").mockReturnValueOnce(0).mockReturnValue(0.999);
    const { container } = render(<Wordmark />);
    const timings = container.querySelector(".cipher-wordmark")?.getAttribute(
      "data-cipher-timings",
    );
    expect(timings).toBeTruthy();
    const parsed = JSON.parse(timings ?? "[]") as Array<{
      delay: number;
      duration: number;
      letter: string;
    }>;
    expect(parsed.length).toBeGreaterThan(0);
    const active = parsed.filter((slot) => slot.letter !== " ");
    let locked = 0;
    for (const [index, slot] of active.entries()) {
      const advance = index === 0 ? WORDMARK_MIN_STEPS : WORDMARK_MAX_STEPS;
      expect(slot.delay).toBe(locked * WORDMARK_FRAME_MS);
      expect(slot.duration).toBe(advance * WORDMARK_FRAME_MS);
      locked += advance;
    }
    expect(locked * WORDMARK_FRAME_MS).toBeGreaterThan(2300);
    expect(locked * WORDMARK_FRAME_MS).toBeLessThan(6000);
  });

  it("exposes the brand name once, and hides the cipher from AT", () => {
    render(<Wordmark />);
    expect(
      screen.getAllByText(WORDMARK, { selector: ".visually-hidden" }),
    ).toHaveLength(1);
    expect(
      document.querySelector(".wordmark__slots")?.getAttribute("aria-hidden"),
    ).toBe("true");
    expect(document.querySelector("canvas.cipher-wordmark__canvas")).toBeTruthy();
  });
});
