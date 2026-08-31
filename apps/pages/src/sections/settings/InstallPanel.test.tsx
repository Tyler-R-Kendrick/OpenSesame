/** @vitest-environment jsdom */
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { installOfferDependencies } from "../../components/InstallOffer.js";
import type { InstallOutcome, InstallState } from "../../lib/install.js";
import { installViewSeams } from "../../lib/use-install.js";
import { InstallPanel } from "./InstallPanel.js";

const originalDeps = { ...installOfferDependencies };

function withState(state: InstallState) {
  installViewSeams.state = state;
  installViewSeams.install = () => Promise.resolve<InstallOutcome>("accepted");
}

beforeEach(() => {
  // The nested card asks for persistent storage on `installed`. Left real it
  // would settle outside `act` and latch install.ts's module-wide flag, which
  // is invisible until an unrelated test in this file depends on it.
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

describe("Settings → General → Install", () => {
  it("is where the offer lives once the ceremony is done with", () => {
    withState("prompt");
    render(<InstallPanel />);
    expect(screen.getByRole("heading", { name: "Install" })).toBeDefined();
    expect(
      screen.getByRole("button", { name: "Install OpenSesame" }),
    ).toBeDefined();
  });

  it("still reports an install that has already happened", () => {
    // Not an offer, but a fact worth confirming — and the panel is the only
    // place left to confirm it once setup has run.
    withState("installed");
    render(<InstallPanel />);
    expect(screen.getByText("Installed")).toBeDefined();
  });

  it("is absent where the browser can neither install nor report one", () => {
    // The same withholding rule as the ceremony step (ADR 0086 §5): no
    // heading, no row, nothing that explains what this browser will not do.
    withState("unavailable");
    const { container } = render(<InstallPanel />);
    expect(container.firstChild).toBeNull();
    expect(screen.queryByRole("heading", { name: "Install" })).toBeNull();
  });
});
