import { capabilityPorts } from "@opensesame/app-core/lib/configuration/capabilities-ports.js";
/** @vitest-environment jsdom */
import { FIXTURE_MANAGED_POLICY } from "@opensesame/app-core/lib/configuration/doubles/composition-fixture.js";
import {
  double,
  resetDouble,
} from "@opensesame/app-core/lib/configuration/doubles/test-support.js";
import { installDoublePorts } from "@opensesame/app-core/lib/configuration/doubles/test-support.js";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { describe, expect, it, vi } from "vitest";
import { expectInTray } from "../../components/tray.test-support.js";
import {
  CapabilitiesPanel,
  capabilitiesPanelSeams,
} from "./CapabilitiesPanel.js";
import {
  PERSONAL_SELECTION,
  installPanelFixture,
  panelVault,
  renderPanel,
} from "./capabilities-panel.test-support.js";
import { SettingsFileContext } from "./files/context.js";

installDoublePorts();

installPanelFixture();

describe("switches — the reviewed change, from a section or a tile", () => {
  it("shows a running capability as on, and no always-on one as a switch", () => {
    renderPanel();
    expect(
      screen
        .getByRole("switch", { name: "Agent tools (WebMCP)" })
        .getAttribute("aria-checked"),
    ).toBe("true");
    expect(screen.queryByRole("switch", { name: "Passwords" })).toBeNull();
    // The page draws one list; there is no second one to disagree with it.
    expect(
      screen.queryByRole("list", { name: "Optional capabilities" }),
    ).toBeNull();
  });

  it("switching a capability off commits in place with the root removed", async () => {
    renderPanel();
    fireEvent.click(
      screen.getByRole("switch", { name: "Agent tools (WebMCP)" }),
    );
    expect(screen.queryByTestId("capability-review")).toBeNull();
    await waitFor(() => expect(double.commits).toHaveLength(1));
    expect(double.commits[0]?.draft.selectedOptional).toEqual([
      "vault.passkey-records",
    ]);
    expect(double.disabled).toHaveLength(0);
  });

  it("switching a capability on commits in place with the root added — a choice is not one-way", async () => {
    renderPanel();
    fireEvent.click(screen.getByRole("switch", { name: "Federated sign-in" }));
    expect(screen.queryByTestId("capability-review")).toBeNull();
    await waitFor(() => expect(double.commits).toHaveLength(1));
    expect(double.commits[0]?.draft.selectedOptional).toContain(
      "identity.federation",
    );
    // Adding is not disabling: nothing was force-stopped on the way.
    expect(double.disabled).toHaveLength(0);
  });

  it("trays a refused commit and marks the panel, then clears it on a good one", async () => {
    // SAFETY: fixture constructed in this test matches the declared contract the panel reads.
    const refused = { status: "refused", reason: "policy" } as never;
    const commit = vi
      .spyOn(capabilityPorts.compositionStore, "commit")
      .mockResolvedValueOnce(refused);
    renderPanel();
    fireEvent.click(screen.getByRole("switch", { name: "Federated sign-in" }));
    await expectInTray("refused · policy");
    expect(screen.getByRole("img", { name: "refused · policy" })).toBeTruthy();
    commit.mockRestore();
    fireEvent.click(screen.getByRole("switch", { name: "Federated sign-in" }));
    await waitFor(() =>
      expect(
        screen.queryByRole("img", { name: "refused · policy" }),
      ).toBeNull(),
    );
  });

  it("gives every commit its own revision, even when the clock does not move", async () => {
    // The wall clock is not a source of uniqueness. A browser clamps
    // `Date.now()` for Spectre, a test harness freezes it outright, and two
    // commits inside one tick then carry the same revision — which the
    // commit preflight rightly reads as a conflict (CONSENT-08), refusing
    // the second with `selection-revision`. That is how a person who had
    // chosen one capability could never choose a second.
    capabilitiesPanelSeams.now = () => "2026-09-10T00:00:00.000Z";
    renderPanel();
    fireEvent.click(screen.getByRole("switch", { name: "Federated sign-in" }));
    await waitFor(() => expect(double.commits).toHaveLength(1));
    fireEvent.click(
      await screen.findByRole("switch", { name: "Agent tools (WebMCP)" }),
    );
    await waitFor(() => expect(double.commits).toHaveLength(2));
    expect(double.commits[1]?.draft.revision).not.toEqual(
      double.commits[0]?.draft.revision,
    );
    expect(double.commits[1]?.receipt.selectionRevision).toEqual(
      double.commits[1]?.draft.revision,
    );
  });

  it("says a reload is owed while an unloaded module is still evaluated here", () => {
    resetDouble({
      selection: {
        ...PERSONAL_SELECTION,
        selectedOptional: ["vault.passkey-records"],
      },
      evaluatedModuleIds: ["agents.webmcp/runtime"],
    });
    renderPanel();
    expect(screen.getByTestId("capabilities-restart").textContent).toContain(
      "reload",
    );
    fireEvent.click(screen.getByRole("button", { name: "Reload now" }));
    expect(capabilitiesPanelSeams.reload).toHaveBeenCalled();
  });

  it("has no Visual / Source / Effective toggle and no key to a text view of itself", () => {
    const openFile = vi.fn();
    render(
      <MemoryRouter>
        <SettingsFileContext.Provider value={{ openFile }}>
          <CapabilitiesPanel />
        </SettingsFileContext.Provider>
      </MemoryRouter>,
    );
    expect(screen.queryByRole("radiogroup")).toBeNull();
    expect(
      screen.queryByTestId("capability-source-installation-selection"),
    ).toBeNull();
    // The page is how its documents are seen; neither it nor the operator's
    // policy section carries a key that opens their YAML.
    expect(
      screen.queryByRole("button", { name: /^Open .*\.yaml$/ }),
    ).toBeNull();
    expect(openFile).not.toHaveBeenCalled();
  });
});

describe("SURFACE-06 — a member never sees policy controls", () => {
  it("shows the instance policy only to the operator of a personal-local device in the personal tomb", () => {
    renderPanel();
    expect(screen.getByTestId("instance-capabilities-panel")).toBeTruthy();
    expect(screen.getByTestId("purpose-card-personal")).toBeTruthy();
  });

  it("hides it from a guest and from any other tomb", () => {
    panelVault.current = { tomb: "personal", guest: true };
    renderPanel();
    expect(screen.queryByTestId("instance-capabilities-panel")).toBeNull();
    cleanup();
    panelVault.current = { tomb: "project-4f2a", guest: false };
    renderPanel();
    expect(screen.queryByTestId("instance-capabilities-panel")).toBeNull();
  });

  it("hides it from a member of a managed instance", () => {
    resetDouble({
      policy: FIXTURE_MANAGED_POLICY,
      provenance: "same-origin-deployment",
    });
    renderPanel();
    expect(screen.queryByTestId("instance-capabilities-panel")).toBeNull();
    expect(screen.queryByTestId("purpose-card-personal")).toBeNull();
    expect(screen.queryByRole("button", { name: /Personal/ })).toBeNull();
  });
});
