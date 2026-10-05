/** @vitest-environment jsdom */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AscendProvider } from "../lib/pane-trail.js";
import { UpLink } from "./UpLink.js";

// jsdom cannot navigate: cancel the browser's default once React has seen the
// click, so a link left to the browser stays quiet without changing what runs.
const stopNavigation = (event: Event) => event.preventDefault();
document.addEventListener("click", stopNavigation);

afterEach(cleanup);

function renderLink(ascend: (() => void) | null) {
  render(
    <MemoryRouter initialEntries={["/vault?f=all"]}>
      <AscendProvider value={ascend}>
        <UpLink pane="tree" to="/vault">
          up
        </UpLink>
      </AscendProvider>
    </MemoryRouter>,
  );
  return screen.getByRole("link", { name: "up" });
}

describe("UpLink", () => {
  it("climbs through the trail where the panes are drilled into", () => {
    const ascend = vi.fn();
    fireEvent.click(renderLink(ascend));
    expect(ascend).toHaveBeenCalledWith("tree", "/vault");
  });

  it("keeps its address, so it can still open in a new tab", () => {
    expect(renderLink(vi.fn()).getAttribute("href")).toBe("/vault");
  });

  it("leaves a modified click to the browser", () => {
    const ascend = vi.fn();
    fireEvent.click(renderLink(ascend), { ctrlKey: true });
    expect(ascend).not.toHaveBeenCalled();
  });

  it("is an ordinary link where there is no trail", () => {
    const link = renderLink(null);
    const event = new MouseEvent("click", { bubbles: true, cancelable: true });
    link.dispatchEvent(event);
    expect(link.getAttribute("href")).toBe("/vault");
  });
});
