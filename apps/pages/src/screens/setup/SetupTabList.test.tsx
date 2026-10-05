/** @vitest-environment jsdom */
import { resolveGuideTargetElement } from "@opensesame/app-core/tutorial/registry/targets.js";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useRovingTabs } from "../use-roving-tabs.js";
import { SetupBrand } from "./SetupBrand.js";
import { SetupTabList } from "./SetupTabList.js";

afterEach(cleanup);

const TABS = [
  { id: "capabilities", tab: "capabilities" },
  { id: "identity", tab: "identity" },
];

function Strip({
  index,
  select,
}: { index: number; select: (at: number) => void }) {
  const { tabProps } = useRovingTabs({
    count: TABS.length,
    index,
    select,
  });
  return (
    <SetupTabList
      tabs={TABS}
      index={index}
      tabProps={tabProps}
      select={select}
    />
  );
}

describe("the setup tab strip", () => {
  it("is one tablist with a tab for each concern, the selected one the roving stop", () => {
    render(<Strip index={1} select={() => {}} />);
    const list = screen.getByRole("tablist", { name: "Setup step" });
    expect(list.querySelectorAll('[role="tab"]')).toHaveLength(2);
    expect(
      screen
        .getByRole("tab", { name: "identity" })
        .getAttribute("aria-selected"),
    ).toBe("true");
    expect(screen.getByRole("tab", { name: "identity" }).tabIndex).toBe(0);
    expect(screen.getByRole("tab", { name: "capabilities" }).tabIndex).toBe(-1);
  });

  it("selects a tab on press and walks the strip with the arrow keys", () => {
    const select = vi.fn();
    render(<Strip index={0} select={select} />);
    fireEvent.click(screen.getByRole("tab", { name: "identity" }));
    expect(select).toHaveBeenLastCalledWith(1);
    fireEvent.keyDown(screen.getByRole("tab", { name: "capabilities" }), {
      key: "ArrowRight",
    });
    expect(select).toHaveBeenLastCalledWith(1);
  });

  it("is the setup.tabs control a tutorial points at", () => {
    render(<Strip index={0} select={() => {}} />);
    expect(resolveGuideTargetElement("setup.tabs")).toBe(
      screen.getByRole("tablist", { name: "Setup step" }),
    );
  });
});

describe("the wordmark of a setup-framed screen", () => {
  it("keeps a seat beside it for the help key (ADR 0165)", () => {
    const { container } = render(<SetupBrand />);
    expect(container.querySelector(".setup__wordmark")).not.toBeNull();
    expect(container.querySelector(".gate-seat")).not.toBeNull();
    // Empty without the support capability: no key, no width.
    expect(container.querySelector(".gate-seat")?.childElementCount).toBe(0);
  });
});
