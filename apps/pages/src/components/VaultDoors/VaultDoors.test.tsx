/** @vitest-environment jsdom */
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { VaultDoors } from "./VaultDoors.js";

afterEach(cleanup);

describe("VaultDoors", () => {
  it("applies door shift styles on the unlock shell", () => {
    const paneRef = { current: document.createElement("div") };
    paneRef.current.className = "unlock";
    document.body.append(paneRef.current);
    const onComplete = vi.fn();
    render(
      <VaultDoors
        active
        openStartMs={performance.now()}
        splitX={320}
        paneRef={paneRef}
        reducedMotion
        onComplete={onComplete}
      />,
    );
    expect(paneRef.current.classList.contains("unlock--doors")).toBe(true);
    expect(
      paneRef.current.style.getPropertyValue("--unlock-door-progress"),
    ).toBe("1");
    paneRef.current.remove();
  });

  it("renders two door panels at the split while the motion is starting", () => {
    const paneRef = { current: document.createElement("div") };
    paneRef.current.className = "unlock";
    document.body.append(paneRef.current);
    const { container } = render(
      <VaultDoors
        active
        openStartMs={null}
        splitX={320}
        paneRef={paneRef}
        reducedMotion={false}
        onComplete={vi.fn()}
      />,
    );
    const left = container.querySelector(".vault-doors__panel--left");
    const right = container.querySelector(".vault-doors__panel--right");
    expect(left).toBeTruthy();
    expect(right).toBeTruthy();
    expect(left?.getAttribute("style")).toContain("inline-size: 320px");
    expect(right?.getAttribute("style")).toContain("320px");
    paneRef.current.remove();
  });
});
