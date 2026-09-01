/** @vitest-environment jsdom */
import { cleanup, fireEvent, render } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { useGuideTarget } from "./react.jsx";
import {
  duplicateGuideTargetMounts,
  isMountedGuideTarget,
  observeGuideTarget,
  resolveGuideTargetElement,
} from "./targets.js";

/**
 * Binding has to follow the element, not the component that renders it.
 *
 * These are the two shapes the app actually contains: a control inside a panel
 * that opens later, and a control that swaps between two mutually exclusive
 * branches. An effect keyed on the id reads `ref.current` once, so both used to
 * leave the registry describing something other than what is on screen.
 */
describe("a target whose element arrives after its component", () => {
  afterEach(cleanup);

  function Deferred() {
    const [open, setOpen] = useState(false);
    const ref = useGuideTarget<HTMLButtonElement>("shell.notifications");
    return (
      <div>
        <button type="button" onClick={() => setOpen(true)}>
          open
        </button>
        {open ? (
          <button type="button" ref={ref}>
            health
          </button>
        ) : null}
      </div>
    );
  }

  it("registers when the panel holding it finally opens", () => {
    const { getByText } = render(<Deferred />);
    expect(isMountedGuideTarget("shell.notifications")).toBe(false);

    fireEvent.click(getByText("open"));

    expect(isMountedGuideTarget("shell.notifications")).toBe(true);
    expect(resolveGuideTargetElement("shell.notifications")?.textContent).toBe(
      "health",
    );
  });

  function Swapping() {
    const [empty, setEmpty] = useState(true);
    const ref = useGuideTarget<HTMLButtonElement>("vault.create");
    return (
      <div>
        <button type="button" onClick={() => setEmpty(false)}>
          fill
        </button>
        {/* Distinct keys, so React really does discard one node and build the
            other — the two "new item" affordances in VaultSection live in
            different parents, and reusing one node here would test nothing. */}
        {empty ? (
          <div key="empty">
            <button type="button" ref={ref}>
              empty-state
            </button>
          </div>
        ) : (
          <section key="list">
            <button type="button" ref={ref}>
              list-header
            </button>
          </section>
        )}
      </div>
    );
  }

  it("follows a control that swaps between two branches", () => {
    const { getByText } = render(<Swapping />);
    expect(resolveGuideTargetElement("vault.create")?.textContent).toBe(
      "empty-state",
    );

    fireEvent.click(getByText("fill"));

    // The old node is gone from the document; the registry must not still be
    // holding it, or the walkthrough points at nothing.
    expect(resolveGuideTargetElement("vault.create")?.textContent).toBe(
      "list-header",
    );
    expect(resolveGuideTargetElement("vault.create")?.isConnected).toBe(true);
    expect(duplicateGuideTargetMounts()).toEqual([]);
  });

  it("unregisters when the element leaves", () => {
    const { unmount } = render(<Deferred />);
    unmount();
    expect(isMountedGuideTarget("shell.notifications")).toBe(false);
  });
});

describe("waiting for a target to appear", () => {
  afterEach(cleanup);

  /**
   * `appear` asks the same question `focus` does. A wait satisfied by mere
   * registration would resolve on the copy a media query has hidden, and hand
   * the next instruction a control nobody can see.
   *
   * This is the responsive shell in miniature: the phone chip and the desktop
   * rail row both register the same id, one of them hidden by a media query.
   * The wait must ignore the hidden candidate and settle only once a candidate
   * somebody can actually see is mounted.
   */
  it("ignores a hidden candidate and settles on a visible one", async () => {
    const hiddenHolder = document.createElement("div");
    hiddenHolder.style.display = "none";
    document.body.append(hiddenHolder);

    function Chip() {
      const ref = useGuideTarget<HTMLButtonElement>("vault.filter.logins");
      return (
        <button type="button" ref={ref}>
          hidden-chip
        </button>
      );
    }
    render(<Chip />, { container: hiddenHolder });
    expect(isMountedGuideTarget("vault.filter.logins")).toBe(false);

    const controller = new AbortController();
    let settled = false;
    const waiting = observeGuideTarget(
      "vault.filter.logins",
      "appear",
      controller.signal,
    ).then(() => {
      settled = true;
    });

    await Promise.resolve();
    expect(settled).toBe(false);

    // The visible copy mounts, which is what announces to the registry.
    function RailRow() {
      const ref = useGuideTarget<HTMLButtonElement>("vault.filter.logins");
      return (
        <button type="button" ref={ref}>
          visible-row
        </button>
      );
    }
    render(<RailRow />);

    await waiting;
    expect(settled).toBe(true);
    expect(resolveGuideTargetElement("vault.filter.logins")?.textContent).toBe(
      "visible-row",
    );

    controller.abort();
    hiddenHolder.remove();
  });
});
