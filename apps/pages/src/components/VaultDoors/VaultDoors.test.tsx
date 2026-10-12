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
    paneRef.current.remove();
  });
});
