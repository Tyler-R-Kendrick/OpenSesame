/** @vitest-environment jsdom */
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { AmbientAuthPanel } from "./AmbientAuthPanel.js";

afterEach(cleanup);

describe("AmbientAuthPanel", () => {
  it("is absent with no provider to choose and none deployed — no dead key, no dead sentence", () => {
    const { container } = render(<AmbientAuthPanel />);
    expect(container.querySelector("#ambient-auth")).toBeNull();
    expect(container.querySelector("button")).toBeNull();
    expect(container.textContent).toBe("");
  });
});
