import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  type ProviderFields,
  addProvider as addProviderWith,
  clearInstallOffer,
  commit,
  installNow,
  offering,
  openSetup,
  resetSetupScreen,
  ways,
} from "./setup/test-harness.js";
import { createSetupSeams } from "./setup/test-seams.js";

const seams = createSetupSeams();
const { completeSetup } = seams;

const addProvider = (preset: RegExp, fields: ProviderFields) =>
  addProviderWith(seams, preset, fields);

beforeEach(() => resetSetupScreen(seams));

afterEach(() => {
  cleanup();
  clearInstallOffer();
});

describe("keeping it on this device", () => {
  it("leaves no trace at all where the browser will not install", () => {
    // ADR 0086 — the same rule that withholds Unlock while there is no sealed
    // vault. Not a heading over an empty space explaining what cannot be done.
    openSetup();
    expect(screen.queryByText("Keep it on this device")).toBeNull();
    expect(
      screen.queryByRole("button", { name: "Install OpenSesame" }),
    ).toBeNull();
  });

  it("rides beneath the active step, never a tab of its own", () => {
    // A tab per concern (ADR 0114); installing is not one of them.
    offering("prompt");
    openSetup();

    expect(screen.getAllByRole("tab")).toHaveLength(4);
    expect(screen.getByText("Keep it on this device")).toBeDefined();
    expect(
      document
        .querySelector(".setup__body")
        ?.contains(screen.getByText("Keep it on this device")),
    ).toBe(true);
  });

  it("offers the install inside the card, never as the screen's commit", () => {
    // `docs/design/controls.md`: the foot bar commits the ceremony; the card
    // acts on its own content. The commit still reads "Finish setup".
    offering("prompt");
    openSetup();

    const action = screen.getByRole("button", { name: "Install OpenSesame" });
    expect(action.closest(".setup__foot")).toBeNull();
    expect(action.closest(".found")).not.toBeNull();
    expect(commit().getAttribute("aria-label")).toBe("Finish setup");
  });

  it("never gates finishing setup", async () => {
    // Installing has no wrong answer, so it cannot hold the commit.
    offering("prompt");
    const onDone = openSetup(vi.fn());

    fireEvent.click(commit());
    await waitFor(() => expect(onDone).toHaveBeenCalled());
    expect(installNow).not.toHaveBeenCalled();
    // And it leaves no mark on the record: installing is not a concern tab.
    expect(completeSetup).toHaveBeenCalledWith({
      ways: ["builtin"],
      service: false,
      skipped: [],
    });
  });

  it("gives iOS the manual road rather than a button that cannot work", () => {
    offering("manual");
    openSetup();
    expect(screen.getByText("Keep it on this device")).toBeDefined();
    expect(
      screen.queryByRole("button", { name: "Install OpenSesame" }),
    ).toBeNull();
    expect(
      screen.getByText("Add to Home Screen", { selector: "strong" }),
    ).toBeDefined();
  });

  it("keeps reporting the install once it has happened", () => {
    offering("installed");
    openSetup();
    expect(screen.getByText("Installed")).toBeDefined();
    expect(
      screen.queryByRole("button", { name: "Install OpenSesame" }),
    ).toBeNull();
  });
});
