/** @vitest-environment jsdom */
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { armInstall, installSeams, resetInstallForTest } from "./install.js";
import { installViewSeams, useInstall } from "./use-install.js";

const originalSeams = { ...installSeams };

function firePrompt(): void {
  const event = new Event("beforeinstallprompt", { cancelable: true });
  Object.assign(event, {
    prompt: () => Promise.resolve({ outcome: "accepted" }),
  });
  window.dispatchEvent(event);
}

function Probe() {
  const { state, visible } = useInstall();
  return <output>{`${state}/${visible ? "shown" : "hidden"}`}</output>;
}

beforeEach(() => {
  resetInstallForTest();
  Object.assign(installSeams, originalSeams, {
    runningStandalone: () => false,
    appleTouchDevice: () => false,
  });
  armInstall();
});

afterEach(() => {
  cleanup();
  resetInstallForTest();
  Object.assign(installSeams, originalSeams);
  // In `afterEach`, never at the end of a test body: a failing assertion would
  // skip an inline reset and leak the override into every test after it.
  installViewSeams.state = null;
  installViewSeams.persisted = null;
  installViewSeams.install = null;
});

describe("useInstall", () => {
  it("reports what the browser is offering, and whether to render at all", () => {
    render(<Probe />);
    expect(screen.getByText("unavailable/hidden")).toBeDefined();

    act(() => firePrompt());
    expect(screen.getByText("prompt/shown")).toBeDefined();
  });

  it("does not lose an event that lands while the app is still mounting", () => {
    // The race this hook exists to survive. `beforeinstallprompt` fires as
    // soon as Chromium decides the page is eligible, which on a fast load is
    // after the first render and before a passive effect would have
    // subscribed. A useState + useEffect hook subscribes without re-reading
    // and stays "unavailable" forever, because there is no second event.
    act(() => {
      render(<Probe />);
      // Inside the same act: React has rendered but not flushed effects.
      firePrompt();
    });
    expect(screen.getByText("prompt/shown")).toBeDefined();
  });

  it("keeps every consumer on one answer", () => {
    // The ceremony's heading and the card beneath it are separate components
    // reading this hook. If they could disagree, the heading would stand over
    // a body that had decided to render nothing.
    function Pair() {
      return (
        <>
          <Probe />
          <Probe />
        </>
      );
    }
    render(<Pair />);
    act(() => firePrompt());
    expect(screen.getAllByText("prompt/shown")).toHaveLength(2);
  });

  it("follows the browser installing the app from anywhere", () => {
    render(<Probe />);
    act(() => firePrompt());
    act(() => {
      window.dispatchEvent(new Event("appinstalled"));
    });
    expect(screen.getByText("installed/shown")).toBeDefined();
  });

  it("unsubscribes when the last consumer goes", () => {
    const view = render(<Probe />);
    view.unmount();
    // No listener left to update a component that is gone: an announce after
    // unmount must not throw or warn.
    act(() => firePrompt());
    expect(document.body.textContent).toBe("");
  });
});

describe("the test seam", () => {
  it("overrides values without changing how many hooks run", () => {
    // Swapping the hook itself would make the real and stubbed versions call
    // different numbers of hooks, so driving a transition inside one test —
    // the obvious thing to want — would throw "Rendered fewer hooks".
    const view = render(<Probe />);
    expect(screen.getByText("unavailable/hidden")).toBeDefined();

    installViewSeams.state = "prompt";
    view.rerender(<Probe />);
    expect(screen.getByText("prompt/shown")).toBeDefined();

    installViewSeams.state = "installed";
    view.rerender(<Probe />);
    expect(screen.getByText("installed/shown")).toBeDefined();
  });
});
