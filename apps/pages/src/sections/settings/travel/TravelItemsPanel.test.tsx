import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { travelSeams } from "@opensesame/app-core/lib/travel/index.js";
import { travelItemSeams } from "@opensesame/app-core/lib/travel/items-deps.js";
import {
  formatReturnCode,
  mintReturnSecret,
} from "@opensesame/app-core/lib/travel/return-code.js";
import {
  type FakeItemsVault,
  fakeItemsVault,
  folder,
  login,
} from "@opensesame/app-core/lib/travel/travel-items.test-support.js";
import {
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

const originalItemDeps = travelItemSeams.deps;
const originalDeps = travelSeams.deps;
const originalVaultsSeams = { ...vaultsSeams };
const originalHooks = { ...vaultHooksSeams };
let fake: FakeItemsVault;
let guest = false;

beforeEach(() => {
  fake = fakeItemsVault(
    [
      login("Bank", { folderId: "f-1", notes: "n" }),
      login("Mail", { folderId: "f-2" }),
    ],
    [folder("f-1", "Money"), folder("f-2", "Misc")],
  );
  guest = false;
  const origin = fakeOrigin();
  putVault(origin, "personal");
  origin.vaults = [vault("personal", "open")];
  travelSeams.deps = origin.deps;
  travelItemSeams.deps = fake.deps;
  Object.assign(vaultsSeams, {
    listDeviceVaults: (): DeviceVault[] => [
      {
        id: "personal",
        kind: "personal",
        label: "personal",
        named: false,
        sealedAt: null,
        state: "open",
        sharedKey: false,
      },
    ],
  });
  Object.assign(vaultHooksSeams, {
    useVault: () => ({
      ...vaultStore.getSnapshot(),
      status: "unlocked" as const,
      guest,
      items: fake.body.items,
      folders: fake.body.folders,
    }),
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  travelItemSeams.deps = originalItemDeps;
  travelSeams.deps = originalDeps;
  Object.assign(vaultsSeams, originalVaultsSeams);
  Object.assign(vaultHooksSeams, originalHooks);
});

const KEY = "Choose items to leave at home";

async function packBank() {
  fireEvent.click(screen.getByRole("button", { name: KEY }));
  fireEvent.click(screen.getByRole("switch", { name: "Stays home: Bank" }));
  fireEvent.click(
    screen.getByRole("button", { name: "Pack the items for travel" }),
  );
  return screen.findByText("Ready to leave");
}

describe("Settings › Vaults › Travel › leave items at home (ADR 0171)", () => {
  it("draws the row only where there is an item that can leave, and refused for a guest", () => {
    fake.body.items = [];
    const { unmount } = render(<TravelPanel />);
    expect(screen.queryByRole("button", { name: KEY })).toBeNull();
    unmount();
    fake.body.items = [login("Bank")];
    guest = true;
    render(<TravelPanel />);
    expect(
      screen.getByRole("button", { name: KEY }).hasAttribute("disabled"),
    ).toBe(true);
  });

  it("keeps the list off the page: titles wait in the sheet, as switches", () => {
    render(<TravelPanel />);
    expect(screen.queryByText("Bank")).toBeNull();
    expect(screen.queryByRole("switch")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: KEY }));
    const sheet = screen.getByRole("dialog", { name: "Leave items at home" });
    expect(sheet.querySelectorAll('[role="switch"]')).toHaveLength(2);
    expect(
      screen
        .getByRole("button", { name: "Pack the items for travel" })
        .hasAttribute("disabled"),
    ).toBe(true);
  });

  it("offers no trashed item, no drop, and no item that holds a file", () => {
    fake.body.items.push(
      login("Gone", { deletedAt: "2026-01-01T00:00:00.000Z" }),
    );
    render(<TravelPanel />);
    fireEvent.click(screen.getByRole("button", { name: KEY }));
    expect(
      screen.queryByRole("switch", { name: "Stays home: Gone" }),
    ).toBeNull();
  });

  it("shows the code once and removes the items only after three confirmations", async () => {
    render(<TravelPanel />);
    await packBank();
    expect(screen.getByText(/^([A-Z2-7]{4}-){7}[A-Z2-7]{4}$/)).toBeTruthy();
    const press = screen.getByRole("button", {
      name: "Take them out of this vault",
    });
    expect(press.hasAttribute("disabled")).toBe(true);
    for (const box of screen.getAllByRole("checkbox")) fireEvent.click(box);
    expect(press.hasAttribute("disabled")).toBe(false);
    expect(fake.body.items).toHaveLength(2);
    fireEvent.click(press);
    await waitFor(() => expect(fake.body.items).toHaveLength(1));
    await screen.findByText(/1 item left this vault/);
    // The panel afterwards says nothing of what left, and keeps no list.
    expect(screen.queryByText("Bank")).toBeNull();
  });

  it("says why when a copy it cannot reach is in play", async () => {
    fake.copies.push("paired_drive");
    render(<TravelPanel />);
    fireEvent.click(screen.getByRole("button", { name: KEY }));
    fireEvent.click(screen.getByRole("switch", { name: "Stays home: Bank" }));
    fireEvent.click(
      screen.getByRole("button", { name: "Pack the items for travel" }),
    );
    await screen.findByLabelText(/a paired drive would hand these items back/);
    expect(fake.body.items).toHaveLength(2);
  });

  it("brings them back from the bundle and the code, a wrong code refused", async () => {
    render(<TravelPanel />);
    await packBank();
    const code = screen.getByText(/^([A-Z2-7]{4}-){7}[A-Z2-7]{4}$/).textContent;
    // Saving the bundle: the sheet hands the browser a file; keep what it was.
    let saved: Blob | null = null;
    URL.createObjectURL = (blob: Blob | MediaSource) => {
      saved = blob instanceof Blob ? blob : null;
      return "blob:trip";
    };
    URL.revokeObjectURL = () => undefined;
    // jsdom cannot navigate to a download.
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(
      () => undefined,
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Save the travel bundle" }),
    );
    const pkgJson = await readBlob(saved);
    for (const box of screen.getAllByRole("checkbox")) fireEvent.click(box);
    fireEvent.click(
      screen.getByRole("button", { name: "Take them out of this vault" }),
    );
    await waitFor(() => expect(fake.body.items).toHaveLength(1));
    // The sheet closed; the bundle is what the person saved.
    fireEvent.click(
      screen.getByRole("button", { name: "Turn off travel mode" }),
    );
    const file = new File([pkgJson], "trip.travel-items.json");
    file.text = async () => pkgJson;
    fireEvent.change(screen.getByLabelText("Choose the travel bundle"), {
      target: { files: [file] },
    });
    await screen.findByText("trip.travel-items.json");
    fireEvent.change(screen.getByLabelText("Return code"), {
      target: { value: await formatReturnCode(mintReturnSecret()) },
    });
    fireEvent.click(screen.getByRole("button", { name: "Open the bundle" }));
    await screen.findByLabelText(/does not open this bundle/);
    fireEvent.change(screen.getByLabelText("Return code"), {
      target: { value: code },
    });
    fireEvent.click(screen.getByRole("button", { name: "Open the bundle" }));
    await screen.findByText("Ready to come back");
    expect(screen.getByText("Bank")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Bring them back" }));
    await waitFor(() => expect(fake.body.items).toHaveLength(2));
    await screen.findByText(/1 item came back/);
  });
});

function readBlob(blob: Blob | null): Promise<string> {
  if (blob === null) throw new Error("no bundle was saved");
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsText(blob);
  });
}
