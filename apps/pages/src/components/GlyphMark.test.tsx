/** @vitest-environment jsdom */
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { GlyphMark } from "./GlyphMark.js";

afterEach(cleanup);

function draw(kind: "vault" | "person" | "org", id: string) {
  const { container } = render(<GlyphMark kind={kind} id={id} />);
  const svg = container.querySelector("svg");
  if (!svg) throw new Error("no glyph drawn");
  return svg;
}

describe("GlyphMark", () => {
  it("is decorative: the control that wears it carries the name", () => {
    const svg = draw("vault", "prj_4f2a");
    expect(svg.getAttribute("aria-hidden")).toBe("true");
    expect(svg.getAttribute("focusable")).toBe("false");
    expect(svg.textContent).toBe("");
  });

  it("draws the same dots for the same id and different ones for another", () => {
    const first = draw("vault", "prj_4f2a");
    const again = draw("vault", "prj_4f2a");
    const other = draw("vault", "prj_9c11");
    const dots = (svg: SVGElement) =>
      svg.querySelector(".glyph__on")?.getAttribute("d");
    expect(dots(first)).toBe(dots(again));
    expect(dots(first)).not.toBe(dots(other));
  });

  it("carries its hue as a custom property, not a fixed colour", () => {
    const svg = draw("person", "prn_8f3c");
    expect(svg.style.getPropertyValue("--glyph-hue")).toBe("165");
  });

  it("raises a dot only where the grid has one, and keeps the rest faint", () => {
    const svg = draw("org", "org_acme");
    const circles = (selector: string) =>
      (svg.querySelector(selector)?.getAttribute("d")?.match(/M/g) ?? [])
        .length;
    expect(circles(".glyph__on") + circles(".glyph__off")).toBe(64);
    expect(circles(".glyph__on")).toBeGreaterThanOrEqual(20);
  });

  it("is a different face for a vault, a person and an organization", () => {
    const faces = (["vault", "person", "org"] as const).map((kind) =>
      draw(kind, "same-id").querySelector(".glyph__on")?.getAttribute("d"),
    );
    expect(new Set(faces).size).toBe(3);
  });
});
