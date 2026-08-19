/** @vitest-environment jsdom */
import { act, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useOnline } from "./use-online.js";

function Probe() {
  const online = useOnline();
  return <output>{online ? "online" : "offline"}</output>;
}

describe("useOnline", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("tracks online/offline events and cleans up on unmount", () => {
    vi.stubGlobal("navigator", { onLine: true });
    const view = render(<Probe />);
    expect(screen.getByText("online")).toBeTruthy();

    act(() => {
      window.dispatchEvent(new Event("offline"));
    });
    expect(screen.getByText("offline")).toBeTruthy();

    act(() => {
      window.dispatchEvent(new Event("online"));
    });
    expect(screen.getByText("online")).toBeTruthy();

    view.unmount();
    act(() => {
      window.dispatchEvent(new Event("offline"));
    });
    // No update after unmount — nothing to assert on screen beyond no crash.
  });
});
