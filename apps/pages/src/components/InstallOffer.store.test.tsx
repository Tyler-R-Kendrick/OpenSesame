/** @vitest-environment jsdom */
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  armInstall,
  installSeams,
  resetInstallForTest,
} from "../lib/install.js";
import { InstallOffer, installOfferDependencies } from "./InstallOffer.js";

/**
 * The card against the **real** store.
 *
 * Every other suite drives it through `installViewSeams.state`, which is right
 * for testing what each state renders — and wrong for the seam between the two.
 * Consuming Chromium's event empties `pending`, and a card that read its own
 * visibility from `pending` alone vanished under the finger that pressed it,
 * for as long as the browser's dialog was open. Nothing pinned that, because no
 * test joined the component to the store it actually reads.
 */

const originalSeams = { ...installSeams };
const originalDeps = { ...installOfferDependencies };

/** Chromium's event, with a `prompt()` this test decides when to settle. */
function offerInstall(): (outcome: "accepted" | "dismissed") => void {
  let settle: (choice: { outcome: "accepted" | "dismissed" }) => void =
    () => {};
  const event = new Event("beforeinstallprompt", { cancelable: true });
  Object.assign(event, {
    prompt: () =>
      new Promise<{ outcome: "accepted" | "dismissed" }>((resolve) => {
        settle = resolve;
      }),
  });
  window.dispatchEvent(event);
  return (outcome) => settle({ outcome });
}

beforeEach(() => {
  resetInstallForTest();
  Object.assign(installSeams, originalSeams, {
    runningStandalone: () => false,
    appleTouchDevice: () => false,
  });
  Object.assign(installOfferDependencies, originalDeps, {
    ensurePersistence: () => Promise.resolve(false),
  });
  armInstall();
});

afterEach(() => {
  cleanup();
  resetInstallForTest();
  Object.assign(installSeams, originalSeams);
  Object.assign(installOfferDependencies, originalDeps);
});

describe("the install offer, against the real store", () => {
  it("appears when Chromium hands over its event", () => {
    render(<InstallOffer />);
    expect(document.querySelector(".found")).toBeNull();

    act(() => {
      offerInstall();
    });
    expect(
      screen.getByRole("button", { name: "Install OpenSesame" }),
    ).toBeDefined();
  });

  it("stays on screen while the browser's dialog is open", () => {
    // The regression this file exists for. Consuming the event has to leave
    // something behind that still renders, or the section the reader is
    // standing in disappears the instant they press the button.
    render(<InstallOffer />);
    let settle: (outcome: "accepted" | "dismissed") => void = () => {};
    act(() => {
      settle = offerInstall();
    });

    fireEvent.click(screen.getByRole("button", { name: "Install OpenSesame" }));

    expect(document.querySelector(".found")).not.toBeNull();
    expect(
      screen.getByRole("button", { name: "Waiting for the browser…" }),
    ).toBeDefined();
    settle("dismissed");
  });

  it("does not strand a heading while the dialog is open", () => {
    // The same failure, seen from the host: `KeepIt` and the Settings panel
    // render a title above this card (ADR 0086 §2).
    render(<InstallOffer heading="Keep it on this device" />);
    let settle: (outcome: "accepted" | "dismissed") => void = () => {};
    act(() => {
      settle = offerInstall();
    });

    fireEvent.click(screen.getByRole("button", { name: "Install OpenSesame" }));

    expect(screen.getByText("Keep it on this device")).toBeDefined();
    expect(document.querySelector(".keep")).not.toBeNull();
    settle("dismissed");
  });

  it("reports the install once the browser confirms it", async () => {
    render(<InstallOffer />);
    let settle: (outcome: "accepted" | "dismissed") => void = () => {};
    act(() => {
      settle = offerInstall();
    });

    fireEvent.click(screen.getByRole("button", { name: "Install OpenSesame" }));
    await act(async () => {
      settle("accepted");
    });

    expect(screen.getByText("Installed")).toBeDefined();
    expect(
      screen.queryByRole("button", { name: "Install OpenSesame" }),
    ).toBeNull();
  });

  it("keeps the button after a refusal the browser did not consume", async () => {
    // NotAllowedError leaves Chromium's event intact, so the offer is not over.
    const event = new Event("beforeinstallprompt", { cancelable: true });
    Object.assign(event, {
      prompt: () =>
        Promise.reject(new DOMException("no activation", "NotAllowedError")),
    });
    render(<InstallOffer />);
    act(() => {
      window.dispatchEvent(event);
    });

    await act(async () => {
      fireEvent.click(
        screen.getByRole("button", { name: "Install OpenSesame" }),
      );
    });

    expect(
      screen.getByRole("button", { name: "Install OpenSesame" }),
    ).toBeDefined();
    // And it must not tell the reader to go to a browser menu that is not the
    // only road left — the working button is right there.
    expect(document.body.textContent).not.toContain("browser's own menu");
  });
});
