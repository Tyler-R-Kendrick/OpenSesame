/** @vitest-environment jsdom */
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { InstallOutcome, InstallState } from "../lib/install.js";
import { installViewSeams } from "../lib/use-install.js";
import { InstallOffer, installOfferDependencies } from "./InstallOffer.js";

const install = vi.fn<() => Promise<InstallOutcome>>();
const originalDeps = { ...installOfferDependencies };

function withState(state: InstallState, persisted = false) {
  installViewSeams.state = state;
  installViewSeams.persisted = persisted;
  installViewSeams.install = install;
}

beforeEach(() => {
  install.mockReset();
  install.mockResolvedValue("accepted");
  Object.assign(installOfferDependencies, originalDeps, {
    ensurePersistence: () => Promise.resolve(false),
  });
});

afterEach(() => {
  cleanup();
  installViewSeams.state = null;
  installViewSeams.persisted = null;
  installViewSeams.install = null;
  Object.assign(installOfferDependencies, originalDeps);
});

describe("the install offer", () => {
  it("renders nothing at all where the browser cannot install", () => {
    // Withheld, not explained away — ADR 0077's rule, ADR 0086 §2. A card
    // whose only content is "your browser will not do this" is a report.
    withState("unavailable");
    const { container } = render(<InstallOffer />);
    expect(container.firstChild).toBeNull();
  });

  it("offers the install as an action inside the card that justifies it", () => {
    withState("prompt");
    render(<InstallOffer />);

    expect(screen.getByText("This browser can install it")).toBeDefined();
    const action = screen.getByRole("button", { name: "Install OpenSesame" });
    // `docs/design/controls.md`: a card acts with `.btn--primary`; the screen's
    // own terminal commit stays the ceremony's `.go`.
    expect(action.className).toContain("btn--primary");
    expect(action.closest(".found")).not.toBeNull();
    expect(document.querySelector(".go")).toBeNull();
  });

  it("names the deployment, not just the host that serves it", () => {
    // Two OpenSesame deploys on one GitHub Pages account differ only by the
    // base path, and that path is what the installed app's scope covers.
    withState("prompt");
    render(<InstallOffer />);
    const base = import.meta.env.BASE_URL.replace(/\/$/, "");
    expect(screen.getByText(`${window.location.host}${base}`)).toBeDefined();
  });

  it("opens the browser dialog from the reader's own press", async () => {
    // `prompt()` only opens inside a transient user activation, so the call
    // has to hang off the gesture and never off an effect.
    withState("prompt");
    render(<InstallOffer />);
    fireEvent.click(screen.getByRole("button", { name: "Install OpenSesame" }));
    await waitFor(() => expect(install).toHaveBeenCalledOnce());
  });

  // The production shape of this — the card surviving a consumed event — lives
  // in `InstallOffer.store.test.tsx`, against the real store. Here it only
  // pins the busy label and `aria-busy`.
  it("says it is waiting while the browser has the dialog open", async () => {
    let settle: (outcome: InstallOutcome) => void = () => {};
    install.mockReturnValue(
      new Promise<InstallOutcome>((resolve) => {
        settle = resolve;
      }),
    );
    withState("prompt");
    render(<InstallOffer />);

    fireEvent.click(screen.getByRole("button", { name: "Install OpenSesame" }));
    const waiting = await screen.findByRole("button", {
      name: "Waiting for the browser…",
    });
    expect(waiting.getAttribute("aria-busy")).toBe("true");
    settle("dismissed");
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Install OpenSesame" }),
      ).toBeDefined(),
    );
  });

  it("gives iOS the three taps, in the words the OS uses", () => {
    // Safari exposes no API for this at all, so naming the steps is the whole
    // of what the app can do.
    withState("manual");
    render(<InstallOffer />);

    expect(
      screen.getByText("Add to Home Screen", { selector: "strong" }),
    ).toBeDefined();
    expect(document.querySelectorAll(".keep__step")).toHaveLength(3);
    // Nothing to press: offering a button that cannot work is the failure.
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("keeps the steps a list for the one engine that renders them", () => {
    // `.keep__steps` is `list-style: none`, which Safari takes as licence to
    // drop list semantics — on the only platform this branch ever reaches.
    withState("manual");
    render(<InstallOffer />);
    expect(screen.getByRole("list")).toBeDefined();
    expect(screen.getAllByRole("listitem")).toHaveLength(3);
  });

  it("does not make the glyphs repeat the words beside them", () => {
    // The Share and Add-to-Home-Screen marks are there for a sighted reader
    // hunting a toolbar shape; naming them would have a screen reader say
    // "Tap Share Share".
    withState("manual");
    render(<InstallOffer />);
    for (const svg of document.querySelectorAll(".keep__glyph svg")) {
      expect(svg.getAttribute("aria-hidden")).toBe("true");
    }
  });

  it("does not tell an iOS in-app browser to look in Safari", () => {
    // `appleTouchDevice()` matches every browser and webview on iOS, so the
    // steps have to read correctly in all of them.
    withState("manual");
    render(<InstallOffer />);
    expect(document.body.textContent).not.toContain("Safari");
  });

  it("reports an install rather than offering one again", () => {
    withState("installed");
    render(<InstallOffer />);
    expect(screen.getByText("Installed")).toBeDefined();
    expect(document.querySelector(".found--done")).not.toBeNull();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("says so when the device agreed to keep the storage", () => {
    withState("installed", true);
    render(<InstallOffer />);
    expect(
      screen.getByText("kept — this device agreed to hold it"),
    ).toBeDefined();
  });

  it("does not claim persistence the browser never granted", () => {
    withState("installed", false);
    render(<InstallOffer />);
    expect(screen.getByText("on this device")).toBeDefined();
    expect(screen.queryByText(/agreed to hold it/)).toBeNull();
  });

  it("withholds the heading with the body, so no host can strand one", () => {
    // ADR 0086 §2. A host that forgot its own guard would otherwise render a
    // heading over nothing.
    withState("unavailable");
    const { container } = render(
      <InstallOffer heading="Keep it on this device" />,
    );
    expect(container.firstChild).toBeNull();
    expect(screen.queryByText("Keep it on this device")).toBeNull();
  });

  it("says nothing when the browser refused to trace the gesture", async () => {
    // `retry` means the event was NOT consumed and the button is still live;
    // announcing a refusal would send the reader off to a browser menu with a
    // working control beside them.
    install.mockResolvedValue("retry");
    withState("prompt");
    render(<InstallOffer />);
    fireEvent.click(screen.getByRole("button", { name: "Install OpenSesame" }));
    await waitFor(() => expect(install).toHaveBeenCalledOnce());
    expect(document.body.textContent).not.toContain("browser's own menu");
  });

  it("says something even when the install call itself throws", async () => {
    install.mockRejectedValue(new Error("boom"));
    withState("prompt");
    render(<InstallOffer />);
    fireEvent.click(screen.getByRole("button", { name: "Install OpenSesame" }));
    await waitFor(() =>
      expect(
        screen.getByText(/could not open the install dialog/),
      ).toBeDefined(),
    );
  });

  it("speaks the outcome, which replaces the card that had focus", async () => {
    // Pressing the button destroys it: `disabled` drops focus to <body> and
    // the answer arrives in a card the reader is no longer standing in.
    install.mockResolvedValue("dismissed");
    withState("prompt");
    render(<InstallOffer />);
    fireEvent.click(screen.getByRole("button", { name: "Install OpenSesame" }));
    await waitFor(() =>
      expect(screen.getByText(/Not installed/)).toBeDefined(),
    );
  });

  it("stays on screen after a refusal, and says where the road is now", () => {
    withState("dismissed");
    render(<InstallOffer />);
    expect(screen.getByText(/from the browser's own menu/)).toBeDefined();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("never claims an outcome it could not read", async () => {
    // This state also covers a browser whose answer was unreadable, so the
    // copy must not tell somebody who just installed that nothing happened.
    withState("dismissed");
    render(<InstallOffer />);
    const text = document.body.textContent ?? "";
    expect(text).not.toContain("nothing was installed");
    expect(text).not.toContain("No harm done");
  });

  it("asks for persistent storage however the install happened", async () => {
    // Not only on the road that goes through our own button: an address-bar
    // install, an iOS Add to Home Screen, or a later launch all land here.
    const ensure = vi.fn().mockResolvedValue(true);
    Object.assign(installOfferDependencies, { ensurePersistence: ensure });
    withState("installed");
    render(<InstallOffer />);
    await waitFor(() => expect(ensure).toHaveBeenCalledOnce());
  });

  it("states the reason installing matters to a vault, not a generic pitch", () => {
    withState("prompt");
    render(<InstallOffer />);
    // The claim `lib/install.ts` then keeps by asking for persistent storage.
    expect(screen.getByText(/can clear a tab's storage/)).toBeDefined();
  });
});
