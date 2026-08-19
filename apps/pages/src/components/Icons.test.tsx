import { cleanup, render } from "@testing-library/react";
import type { ComponentType } from "react";
/** @vitest-environment jsdom */
import { afterEach, describe, expect, it } from "vitest";

import * as Icons from "./Icons.js";

const iconEntries = Object.entries(Icons).filter(
  ([, value]) => typeof value === "function",
) as Array<[string, ComponentType<Icons.IconProps>]>;

describe("Icons", () => {
  afterEach(cleanup);

  it("exports a non-trivial icon set", () => {
    expect(iconEntries.length).toBeGreaterThan(20);
  });

  it("every icon renders an svg, hidden from assistive tech by default", () => {
    for (const [name, Icon] of iconEntries) {
      const { container, unmount } = render(<Icon />);
      const svg = container.querySelector("svg");
      if (!svg) throw new Error(`${name} did not render an svg`);
      if (svg.getAttribute("aria-hidden") !== "true") {
        throw new Error(`${name} should be aria-hidden without a title`);
      }
      if (svg.getAttribute("width") !== "20") {
        throw new Error(`${name} should default to size 20`);
      }
      unmount();
    }
  });

  it("a titled icon is exposed as an image with that title", () => {
    const { container } = render(<Icons.IconVault title="Vault" size={32} />);
    const svg = container.querySelector("svg");
    expect(svg?.getAttribute("role")).toBe("img");
    expect(svg?.getAttribute("aria-hidden")).toBeNull();
    expect(svg?.getAttribute("width")).toBe("32");
    expect(svg?.querySelector("title")?.textContent).toBe("Vault");
  });

  it("passes className through", () => {
    const { container } = render(<Icons.IconAlert className="icon--big" />);
    expect(container.querySelector("svg")?.getAttribute("class")).toBe(
      "icon--big",
    );
  });

  it("IconStar fills only when asked", () => {
    const { container: hollow } = render(<Icons.IconStar />);
    expect(hollow.querySelector("svg")?.getAttribute("fill")).toBe("none");
    const { container: filled } = render(<Icons.IconStar filled />);
    expect(filled.querySelector("svg")?.getAttribute("fill")).toBe(
      "currentColor",
    );
  });

  it("IconStar also supports a title for assistive tech", () => {
    const { container } = render(<Icons.IconStar title="Favourite" />);
    const svg = container.querySelector("svg");
    expect(svg?.getAttribute("role")).toBe("img");
    expect(svg?.querySelector("title")?.textContent).toBe("Favourite");
  });
});
