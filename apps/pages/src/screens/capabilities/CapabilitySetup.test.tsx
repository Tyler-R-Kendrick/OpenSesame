import {
  FIXTURE_CATALOG,
  FIXTURE_MANAGED_POLICY,
} from "@opensesame/app-core/lib/configuration/doubles/composition-fixture.js";
import {
  double,
  resetDouble,
} from "@opensesame/app-core/lib/configuration/doubles/test-support.js";
/** @vitest-environment jsdom */
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { loaderSeams } from "@opensesame/app-core/lib/capabilities/loader.js";
import { installDoublePorts } from "@opensesame/app-core/lib/configuration/doubles/test-support.js";
import { CapabilitySetup } from "./CapabilitySetup.js";
import { downloadSeams } from "./download.js";

installDoublePorts();

const fetchSpy = vi.fn();

beforeEach(() => {
  resetDouble();
  fetchSpy.mockReset();
  vi.stubGlobal("fetch", fetchSpy);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function road(name: string) {
  return screen.getByRole("button", { name: new RegExp(`^${name}`) });
}
function card(id: string) {
  return screen.getByTestId(`capability-card-${id}`);
}
function pick(id: string) {
  const button = card(id).querySelector(".capcard__pick");
  if (!(button instanceof HTMLButtonElement))
    throw new Error(`no pick on ${id}`);
  return button;
}

describe("CONSENT-01 — the cards import nothing and connect to nothing", () => {
  it("renders every card, opens every detail sheet and toggles roots without a single import or request", () => {
    // The loader's only road to an optional module is the module table.
    const moduleTable = vi.spyOn(loaderSeams, "moduleTable");
    render(<CapabilitySetup />);
    fireEvent.click(road("Customize this installation"));
    fireEvent.click(screen.getByTestId("purpose-card-custom"));
    for (const descriptor of FIXTURE_CATALOG.capabilities) {
      // Always-on capabilities are in every plan: no card to choose them.
      if (descriptor.tier === "core") {
        expect(
          screen.queryByTestId(`capability-card-${descriptor.id}`),
        ).toBeNull();
        continue;
      }
      expect(card(descriptor.id)).toBeTruthy();
      fireEvent.click(
        screen.getByRole("button", { name: `Details of ${descriptor.title}` }),
      );
      expect(card(descriptor.id).textContent).toContain("in this distribution");
      fireEvent.click(pick(descriptor.id));
    }
    expect(moduleTable).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(double.commits).toHaveLength(0);
  });

  it("states every fact from the descriptor, including egress and permissions", () => {
    render(<CapabilitySetup />);
    fireEvent.click(road("Customize this installation"));
    fireEvent.click(screen.getByTestId("purpose-card-custom"));
    fireEvent.click(
      screen.getByRole("button", { name: "Details of Push notifications" }),
    );
    const text = card("notifications.web-push").textContent ?? "";
    expect(text).toContain("notifications");
    expect(text).toContain("external-service → the push service (on its own)");
    expect(text).toContain("service-worker");
    expect(text).toContain("Push notifications");
  });
});

describe("purpose cards are presets, previewed until Apply", () => {
  it("renders one card per preset and pre-ticks the preset's defaults as a draft", () => {
    render(<CapabilitySetup />);
    fireEvent.click(road("Customize this installation"));
    for (const id of [
      "personal",
      "family",
      "homelab",
      "organization",
      "custom",
    ]) {
      expect(screen.getByTestId(`purpose-card-${id}`)).toBeTruthy();
    }
    fireEvent.click(screen.getByTestId("purpose-card-homelab"));
    expect(pick("connectors.external").getAttribute("aria-pressed")).toBe(
      "true",
    );
    expect(pick("backup.git-remote").getAttribute("aria-pressed")).toBe("true");
    expect(card("connectors.external").textContent).toContain(
      "not yet applied",
    );
    expect(double.commits).toHaveLength(0);
    expect(double.getSnapshot().plan?.approvedCapabilities).not.toContain(
      "connectors.external",
    );
  });
});

describe("CONSENT-02 — cancel leaves the store untouched", () => {
  it("discards a reviewed draft with zero commits, disables or invalidations", () => {
    render(<CapabilitySetup />);
    fireEvent.click(road("Customize this installation"));
    fireEvent.click(screen.getByTestId("purpose-card-homelab"));
    fireEvent.click(
      screen.getByRole("button", { name: "Save on this device" }),
    );
    expect(screen.getByTestId("capability-review")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByTestId("capability-review")).toBeNull();
    expect(double.commits).toHaveLength(0);
    expect(double.disabled).toHaveLength(0);
    expect(double.invalidations).toHaveLength(0);
    expect(double.getSnapshot().generation).toBe(1);
  });
});

describe("CONSENT-03 — apply commits exactly the reviewed roots", () => {
  it("commits the draft's roots with a receipt bound to the reviewed plan, then reports the outcome", async () => {
    render(<CapabilitySetup />);
    fireEvent.click(road("Customize this installation"));
    fireEvent.click(screen.getByTestId("purpose-card-homelab"));
    fireEvent.click(pick("agents.webmcp"));
    fireEvent.click(
      screen.getByRole("button", { name: "Save on this device" }),
    );
    const review = screen.getByTestId("capability-review");
    expect(review.textContent).toContain("External connectors");
    expect(review.textContent).toContain("the git remote (on its own)");
    fireEvent.click(screen.getByTestId("capability-apply"));
    await waitFor(() =>
      expect(screen.getByTestId("capability-outcome")).toBeTruthy(),
    );
    expect(double.commits).toHaveLength(1);
    const [{ draft, receipt }] = double.commits;
    expect(draft.selectedOptional).toEqual([
      "agents.webmcp",
      "backup.git-remote",
      "connectors.external",
    ]);
    expect(draft.acceptedRequired).toEqual([]);
    expect(receipt.selectionRevision).toBe(draft.revision);
    expect(Object.keys(receipt.exposure)).toContain("backup.git-remote");
    expect(screen.getByTestId("capability-outcome").textContent).toContain(
      "saved on this device",
    );
    expect(double.getSnapshot().plan?.approvedCapabilities).toContain(
      "agents.webmcp",
    );
  });

  it("reports session-only when the store cannot write durably", async () => {
    resetDouble({ durability: "session-only" });
    render(<CapabilitySetup />);
    fireEvent.click(road("Use the minimal configuration"));
    fireEvent.click(screen.getByTestId("capability-apply"));
    await waitFor(() =>
      expect(screen.getByTestId("capability-outcome").textContent).toContain(
        "this session only",
      ),
    );
    expect(double.commits[0]?.draft.selectedOptional).toEqual([]);
  });
});

describe("dependency conflicts explain before/after and offer the alternative", () => {
  it("shows the prohibited dependency and the core alternative, never changing the prohibition", () => {
    resetDouble({
      policy: FIXTURE_MANAGED_POLICY,
      provenance: "same-origin-deployment",
      selection: {
        schemaVersion: 1,
        kind: "InstallationCapabilitySelection",
        instanceId: "acme",
        installationId: "inst-1",
        basePolicyRevision: "7",
        revision: "1",
        acceptedRequired: ["sharing.household"],
        selectedOptional: [],
        chosenAlternatives: { transport: "sharing.drops" },
        delivery: { prefetch: "none", offlineCache: "shell-only" },
      },
    });
    render(<CapabilitySetup />);
    fireEvent.click(road("Customize this installation"));
    expect(screen.queryByTestId("purpose-card-custom")).toBeNull();
    expect(card("connectors.external").textContent).toContain(
      "prohibited by operator",
    );
    fireEvent.click(pick("backup.git-remote"));
    fireEvent.click(
      screen.getByRole("button", { name: "Save on this device" }),
    );
    const review = screen.getByTestId("capability-review");
    expect(review.textContent).toContain("which this instance prohibits");
    expect(
      screen.getByRole("button", { name: /Encrypted file backup/ }),
    ).toBeTruthy();
    expect(
      screen.getByTestId("capability-apply").hasAttribute("disabled"),
    ).toBe(true);
    expect(double.getSnapshot().policy?.capabilities.prohibited).toContain(
      "connectors.external",
    );
    fireEvent.click(
      screen.getByRole("button", { name: /Encrypted file backup/ }),
    );
    expect(screen.getByTestId("capability-review").textContent).not.toContain(
      "prohibits",
    );
    expect(double.commits).toHaveLength(0);
  });
});

describe("CONSENT-10 — export is a file, publish is absent without its capability", () => {
  it("exports the instance configuration and reads it back equal; offers no publish control", async () => {
    const saved: Array<[string, string]> = [];
    downloadSeams.save = (name, text) => {
      saved.push([name, text]);
    };
    render(<CapabilitySetup />);
    fireEvent.click(road("Customize this installation"));
    fireEvent.click(screen.getByTestId("purpose-card-personal"));
    expect(
      screen.queryByRole("button", {
        name: "Publish deployment configuration",
      }),
    ).toBeNull();
    fireEvent.click(
      screen.getByRole("button", { name: "Export instance configuration" }),
    );
    expect(saved).toHaveLength(1);
    const { reimportMatches } = await import(
      "@opensesame/app-core/lib/configuration/capabilities-export.js"
    );
    expect(reimportMatches(saved[0]?.[1] ?? "", double.getSnapshot())).toBe(
      true,
    );
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("offers publish only once a publication capability is approved", async () => {
    render(<CapabilitySetup />);
    fireEvent.click(road("Customize this installation"));
    fireEvent.click(screen.getByTestId("purpose-card-homelab"));
    fireEvent.click(
      screen.getByRole("button", { name: "Save on this device" }),
    );
    fireEvent.click(screen.getByTestId("capability-apply"));
    await waitFor(() =>
      expect(screen.getByTestId("capability-outcome")).toBeTruthy(),
    );
    expect(
      screen.getByRole("button", { name: "Publish deployment configuration" }),
    ).toBeTruthy();
  });
});
