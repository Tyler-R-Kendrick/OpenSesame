import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { travelSeams } from "@opensesame/app-core/lib/travel/index.js";
import {
  type FakeOrigin,
  fakeOrigin,
  putVault,
  vault,
} from "@opensesame/app-core/lib/travel/travel.test-support.js";
import { vaultStore } from "@opensesame/app-core/lib/vault/store.js";
import {
  type DeviceVault,
  vaultsSeams,
} from "@opensesame/app-core/lib/vaults.js";
import { vaultHooksSeams } from "../../../lib/vault/hooks.js";
import { TravelPanel } from "./TravelPanel.js";

const WORK = "prj_1a2b3c4d-0000-4000-8000-00000000work";

const originalDeps = travelSeams.deps;
const originalVaultsSeams = { ...vaultsSeams };
const originalHooks = { ...vaultHooksSeams };
let origin: FakeOrigin;
let guest = false;

function deviceVaults(): DeviceVault[] {
  return origin.vaults.map((entry) => ({
    id: entry.id,
    kind: entry.kind,
    label: entry.label,
    named: entry.name !== null,
    sealedAt: null,
    state: entry.state,
    sharedKey: false,
  }));
}

beforeEach(() => {
  origin = fakeOrigin();
  putVault(origin, "personal");
  putVault(origin, WORK);
  origin.vaults = [vault("personal", "open"), vault(WORK, "locked", "Work")];
  guest = false;
  travelSeams.deps = origin.deps;
  Object.assign(vaultsSeams, { listDeviceVaults: deviceVaults });
  Object.assign(vaultHooksSeams, {
    useVault: () => ({
      ...vaultStore.getSnapshot(),
      status: "unlocked" as const,
      guest,
    }),
  });
});

afterEach(() => {
  cleanup();
  travelSeams.deps = originalDeps;
  Object.assign(vaultsSeams, originalVaultsSeams);
  Object.assign(vaultHooksSeams, originalHooks);
});

describe("Settings › Vaults › Travel (ADR 0140)", () => {
  it("offers nothing to a guest", () => {
    guest = true;
    render(<TravelPanel />);
    expect(screen.getByRole("heading", { name: "Travel" })).toBeTruthy();
    expect(screen.queryByRole("switch")).toBeNull();
    expect(screen.getByText("Open one of your own vaults first")).toBeTruthy();
  });

  it("carries the open vault and sends the rest home, only once both halves are elsewhere", async () => {
    render(<TravelPanel />);
    const personal = screen.getByRole("switch", {
      name: "Safe for travel: personal",
    });
    expect(personal.getAttribute("aria-checked")).toBe("true");
    expect(personal.hasAttribute("disabled")).toBe(true);
    expect(
      screen
        .getByRole("switch", { name: "Safe for travel: Work" })
        .getAttribute("aria-checked"),
    ).toBe("false");

    fireEvent.click(
      screen.getByRole("button", { name: "Pack the rest for travel" }),
    );
    const code = await screen.findByText(/^([A-Z2-7]{4}-){7}[A-Z2-7]{4}$/);
    expect(code).toBeTruthy();
    expect(origin.tombs.has(WORK)).toBe(true);

    const depart = screen.getByRole("button", {
      name: "Take them off this device",
    });
    expect(depart.hasAttribute("disabled")).toBe(true);
    fireEvent.click(
      screen.getByRole("checkbox", {
        name: "The bundle is saved somewhere other than this device",
      }),
    );
    fireEvent.click(
      screen.getByRole("checkbox", {
        name: "The return code is written down, and it stays home",
      }),
    );
    fireEvent.click(depart);
    await screen.findByText("1 vault left this device · 4 files removed");
    await waitFor(() => expect(origin.tombs.has(WORK)).toBe(false));
    expect(origin.tombs.has("personal")).toBe(true);
  });
});
