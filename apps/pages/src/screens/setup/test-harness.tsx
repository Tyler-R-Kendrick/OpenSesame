/**
 * The DOM side of the setup ceremony's harness (ADR 0114).
 *
 * `test-seams.ts` owns the settings, discovery and completion seams; this
 * owns how a suite drives the rendered screen — opening it, reading the
 * ways-in list, filling one provider preset, and finding the terminal
 * commit. Shared by `SetupScreen.test.tsx` and `SetupTabs.test.tsx` so both
 * walk the screen the same way. Test support: never imported by the app.
 */

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { expect, vi } from "vitest";
import { resetDouble } from "../../lib/configuration/doubles/test-support.js";
import type { InstallOutcome, InstallState } from "../../lib/install.js";
import { installViewSeams } from "../../lib/use-install.js";
import { SetupScreen, setupScreenDependencies } from "../SetupScreen.js";
import { SETUP_PANEL_FIXTURE } from "../capabilities/setup-panel-fixture.js";
import type { SetupSeams } from "./test-seams.js";

/** What `addProvider` needs to fill one preset's form. */
export type ProviderFields = {
  /** `[field label, value]` for the presets whose issuer is typed. */
  issuer?: [string, string];
  clientId: string;
};

export const installNow = vi.fn<() => Promise<InstallOutcome>>(
  async () => "accepted",
);

/** What the browser is offering; jsdom offers nothing, the honest default. */
export function offering(state: InstallState): void {
  installViewSeams.state = state;
}

/** jsdom offers no install, so every suite starts from "unavailable". */
export function resetInstallOffer(): void {
  installViewSeams.state = "unavailable";
  installNow.mockClear();
  installViewSeams.install = installNow;
}

/**
 * One reset for a setup suite: the settings/discovery seams, the composition
 * double, the contributed panels (three module owners' worth) and the
 * browser's install offer.
 */
export function resetSetupScreen(seams: SetupSeams): void {
  seams.reset();
  resetDouble();
  setupScreenDependencies.useSetupPanels = () => SETUP_PANEL_FIXTURE;
  resetInstallOffer();
}

export function clearInstallOffer(): void {
  installViewSeams.state = null;
  installViewSeams.persisted = null;
  installViewSeams.install = null;
}

export function fieldNamed(label: string | RegExp): HTMLInputElement {
  const element = screen.getByLabelText(label);
  if (!(element instanceof HTMLInputElement)) {
    throw new Error(`${String(label)} is not an input`);
  }
  return element;
}

export function type(label: string | RegExp, value: string): void {
  const input = fieldNamed(label);
  fireEvent.change(input, { target: { value } });
  // Setup fields commit on blur, exactly as the Settings panel's do.
  fireEvent.blur(input);
}

/** The screen's terminal commit — an ink square, never a text button. */
export function commit(): HTMLElement {
  const foot = document.querySelector(".setup__foot");
  const go = foot?.querySelector(".go");
  if (!(go instanceof HTMLElement)) throw new Error("no commit control");
  return go;
}

export function selectedTab(): string {
  return screen.getByRole("tab", { selected: true }).textContent?.trim() ?? "";
}

export function openSetup(onDone: () => void = vi.fn()): () => void {
  render(<SetupScreen onDone={onDone} />);
  return onDone;
}

/** Setup opened on the identity tab, where the ways-in allowlist lives. */
export function openWaysIn(onDone: () => void = vi.fn()): () => void {
  const done = openSetup(onDone);
  fireEvent.click(screen.getByRole("tab", { name: "identity" }));
  return done;
}

/** The ways-in list, as it reads on screen. */
export function ways(): string[] {
  return [...document.querySelectorAll(".ways__name")].map(
    (node) => node.textContent ?? "",
  );
}

export async function addProvider(
  seams: SetupSeams,
  preset: RegExp,
  fields: ProviderFields,
): Promise<void> {
  const discoveries = seams.discover.mock.calls.length;
  fireEvent.click(screen.getByRole("button", { name: preset }));
  if (fields.issuer) {
    fireEvent.change(fieldNamed(fields.issuer[0]), {
      target: { value: fields.issuer[1] },
    });
  }
  fireEvent.change(fieldNamed("Client ID"), {
    target: { value: fields.clientId },
  });
  fireEvent.click(screen.getByRole("button", { name: /^Add / }));
  // Wait for *this* add to land: `discover` is one mock for the whole test,
  // and an add is finished only once discovery came back and the form
  // closed — until then every preset button is disabled.
  await waitFor(() => {
    expect(seams.discover.mock.calls.length).toBe(discoveries + 1);
    expect(screen.queryByLabelText("Client ID")).toBeNull();
  });
}
