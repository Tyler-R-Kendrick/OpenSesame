import {
  act,
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
  tombFile,
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

describe("Settings › Vaults › Travel (ADR 0143)", () => {
  it("draws both rows for a guest, refused, with the reason on each", () => {
    guest = true;
    render(<TravelPanel />);
    expect(screen.getByRole("heading", { name: "Travel" })).toBeTruthy();
    for (const name of ["Turn on travel mode", "Turn off travel mode"]) {
      expect(
        screen.getByRole("button", { name }).hasAttribute("disabled"),
      ).toBe(true);
    }
    expect(
      screen.getAllByText("Open one of your own vaults first"),
    ).toHaveLength(2);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("keeps the ceremony off the page: the safe list waits in the sheet", () => {
    render(<TravelPanel />);
    expect(screen.queryByRole("switch")).toBeNull();
    expect(screen.getByText("2 vaults on this device")).toBeTruthy();
    fireEvent.click(
      screen.getByRole("button", { name: "Turn on travel mode" }),
    );
    const sheet = screen.getByRole("dialog", { name: "Turn on travel mode" });
    expect(sheet.querySelectorAll('[role="switch"]')).toHaveLength(1);
  });

  it("draws no way to leave while the open vault is the only one: packing would refuse", () => {
    origin.vaults = [vault("personal", "open")];
    render(<TravelPanel />);
    expect(
      screen.queryByRole("button", { name: "Turn on travel mode" }),
    ).toBeNull();
    expect(
      screen.getByRole("button", { name: "Turn off travel mode" }),
    ).toBeTruthy();
  });

  it("carries the open vault and sends the rest home, only once both halves are elsewhere", async () => {
    render(<TravelPanel />);
    fireEvent.click(
      screen.getByRole("button", { name: "Turn on travel mode" }),
    );
    // The open vault always travels: its row says so and draws no switch.
    expect(
      screen.queryByRole("switch", { name: "Safe for travel: personal" }),
    ).toBeNull();
    expect(screen.getByText("open · travels")).toBeTruthy();
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
    await screen.findByText("1 vault left this device");
    expect(screen.getByText("4 files removed")).toBeTruthy();
    // The ceremony is over: its sheet has closed, and the row keeps the receipt.
    expect(screen.queryByRole("dialog")).toBeNull();
    await waitFor(() => expect(origin.tombs.has(WORK)).toBe(false));
    expect(origin.tombs.has("personal")).toBe(true);
  });

  it("keeps the package after a removal cut short, and finishes it with the same press", async () => {
    render(<TravelPanel />);
    fireEvent.click(
      screen.getByRole("button", { name: "Turn on travel mode" }),
    );
    origin.stuck.add(tombFile(WORK, "body"));
    fireEvent.click(
      screen.getByRole("button", { name: "Pack the rest for travel" }),
    );
    await screen.findByText(/^([A-Z2-7]{4}-){7}[A-Z2-7]{4}$/);
    for (const name of [
      "The bundle is saved somewhere other than this device",
      "The return code is written down, and it stays home",
    ]) {
      fireEvent.click(screen.getByRole("checkbox", { name }));
    }
    const depart = screen.getByRole("button", {
      name: "Take them off this device",
    });
    fireEvent.click(depart);
    await screen.findByRole("img", {
      name: /3 files removed · 1 could not be/,
    });
    // Still packed: the code and the button are where they were.
    expect(
      screen.getByRole("button", { name: "Take them off this device" }),
    ).toBeTruthy();

    origin.stuck.clear();
    fireEvent.click(
      screen.getByRole("button", { name: "Take them off this device" }),
    );
    await screen.findByText("1 file removed");
    expect(origin.files.has(tombFile(WORK, "body"))).toBe(false);
  });

  it("refuses a file too large to be a bundle without reading it", async () => {
    render(<TravelPanel />);
    fireEvent.click(
      screen.getByRole("button", { name: "Turn off travel mode" }),
    );
    let read = false;
    const huge = new File(["{}"], "huge.json", { type: "application/json" });
    Object.defineProperty(huge, "size", { value: 65 * 1024 * 1024 });
    huge.text = async () => {
      read = true;
      return "";
    };
    fireEvent.change(screen.getByLabelText("Choose the travel bundle"), {
      target: { files: [huge] },
    });
    expect(
      await screen.findByRole("img", {
        name: "That file is larger than any travel bundle",
      }),
    ).toBeTruthy();
    expect(read).toBe(false);
    expect(screen.getByText("No bundle chosen")).toBeTruthy();
  });

  it("closes the ceremony from Escape, the scrim and its own keep key, and writes nothing", () => {
    render(<TravelPanel />);
    const on = () =>
      fireEvent.click(
        screen.getByRole("button", { name: "Turn on travel mode" }),
      );
    on();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();

    on();
    const close = screen.getAllByRole("button", { name: "Close" })[0];
    if (close === undefined) throw new Error("Close is missing");
    fireEvent.click(close);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(origin.tombs.has(WORK)).toBe(true);
  });

  it("keeps the typed return code while the sheet re-renders", () => {
    render(<TravelPanel />);
    fireEvent.click(
      screen.getByRole("button", { name: "Turn off travel mode" }),
    );
    const field = screen.getByLabelText("Return code");
    field.focus();
    fireEvent.change(field, { target: { value: "A" } });
    fireEvent.change(field, { target: { value: "AB" } });
    expect(document.activeElement).toBe(field);
    expect(
      screen.getByRole("dialog", { name: "Turn off travel mode" }),
    ).toBeTruthy();
  });

  it("goes back to the plan from 'Keep them here' without removing anything", async () => {
    render(<TravelPanel />);
    fireEvent.click(
      screen.getByRole("button", { name: "Turn on travel mode" }),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Pack the rest for travel" }),
    );
    await screen.findByText(/^([A-Z2-7]{4}-){7}[A-Z2-7]{4}$/);
    fireEvent.click(screen.getByRole("button", { name: "Keep them here" }));
    expect(
      screen.getByRole("button", { name: "Pack the rest for travel" }),
    ).toBeTruthy();
    expect(origin.tombs.has(WORK)).toBe(true);
  });

  it("does not close a ceremony while its step is in flight", async () => {
    render(<TravelPanel />);
    fireEvent.click(
      screen.getByRole("button", { name: "Turn on travel mode" }),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Pack the rest for travel" }),
    );
    fireEvent.keyDown(window, { key: "Escape" });
    // Still open: the pack was running when the key was pressed.
    await waitFor(() =>
      expect(
        screen.getByRole("dialog", { name: "Turn on travel mode" }),
      ).toBeTruthy(),
    );
  });

  it("does not update the panel after it is gone", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    // SAFETY: the fixture owns this mutable seam; TravelDeps stays readonly at the type boundary and this assignment preserves duressActive.
    const seam = origin.deps as {
      duressActive: typeof origin.deps.duressActive;
    };
    const duress = seam.duressActive;
    seam.duressActive = async () => {
      await gate;
      return duress();
    };
    const seen: boolean[] = [];
    const onUnhandled = (): void => {
      seen.push(true);
    };
    process.on("unhandledRejection", onUnhandled);
    const view = render(<TravelPanel />);
    fireEvent.click(
      screen.getByRole("button", { name: "Turn on travel mode" }),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Pack the rest for travel" }),
    );
    await act(async () => {
      await Promise.resolve();
    });
    view.unmount();
    try {
      release();
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 30));
      });
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
    expect(seen).toEqual([]);
  });
});
