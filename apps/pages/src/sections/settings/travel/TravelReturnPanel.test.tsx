import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { kvFileName } from "@opensesame/app-core/lib/kv.js";
import {
  completeDeparture,
  packDeparture,
} from "@opensesame/app-core/lib/travel/depart.js";
import { travelSeams } from "@opensesame/app-core/lib/travel/index.js";
import {
  ACK,
  type FakeOrigin,
  PRJ_TRIP,
  PRJ_WORK,
  depart,
  packedDevice,
  tombFile,
} from "@opensesame/app-core/lib/travel/travel.test-support.js";
import { vaultStore } from "@opensesame/app-core/lib/vault/store.js";
import {
  type DeviceVault,
  vaultsSeams,
} from "@opensesame/app-core/lib/vaults.js";
import { vaultHooksSeams } from "../../../lib/vault/hooks.js";
import { TravelPanel } from "./TravelPanel.js";

const CONSENTS = kvFileName("site-broker.consents.v1");
const GRANTED = JSON.stringify({
  consents: [{ origin: "https://a.example", scopes: ["openid"] }],
});

const originalDeps = travelSeams.deps;
const originalVaultsSeams = { ...vaultsSeams };
const originalHooks = { ...vaultHooksSeams };
let origin: FakeOrigin;

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
  origin = packedDevice();
  travelSeams.deps = origin.deps;
  Object.assign(vaultsSeams, { listDeviceVaults: deviceVaults });
  Object.assign(vaultHooksSeams, {
    useVault: () => ({
      ...vaultStore.getSnapshot(),
      status: "unlocked" as const,
      guest: false,
    }),
  });
});

afterEach(() => {
  cleanup();
  travelSeams.deps = originalDeps;
  Object.assign(vaultsSeams, originalVaultsSeams);
  Object.assign(vaultHooksSeams, originalHooks);
});

async function openBundle(bundleJson: string, returnCode: string) {
  fireEvent.click(
    await screen.findByRole("button", { name: "Bring vaults home" }),
  );
  const bundle = new File([bundleJson], "trip.travel.json", {
    type: "application/json",
  });
  // jsdom's File has no text(); the browser's does.
  bundle.text = async () => bundleJson;
  fireEvent.change(screen.getByLabelText("Choose the travel bundle"), {
    target: { files: [bundle] },
  });
  await screen.findByText("trip.travel.json");
  fireEvent.change(screen.getByLabelText("Return code"), {
    target: { value: returnCode },
  });
  fireEvent.click(screen.getByRole("button", { name: "Open the bundle" }));
  await screen.findByRole("list", { name: "Vaults in the bundle" });
}

describe("Travel › coming home (ADR 0143)", () => {
  it("names the site grants a bundle carries and leaves them out unless ticked", async () => {
    origin.files.set(CONSENTS, GRANTED);
    const { pkg } = await depart(origin, [PRJ_TRIP]);
    render(<TravelPanel />);
    await openBundle(pkg.bundleJson, pkg.returnCode);

    expect(screen.getByText("5 files · 1 site grant")).toBeTruthy();
    const tick = screen.getByRole("checkbox", {
      name: "Let these sites in again: https://a.example",
    });
    if (!(tick instanceof HTMLInputElement)) throw new Error("not a checkbox");
    expect(tick.checked).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Bring them home" }));
    await screen.findByText("2 vaults came home");
    expect(origin.files.has(CONSENTS)).toBe(false);
  });

  it("brings the grants back once the box is ticked", async () => {
    origin.files.set(CONSENTS, GRANTED);
    const { pkg } = await depart(origin, [PRJ_TRIP]);
    render(<TravelPanel />);
    await openBundle(pkg.bundleJson, pkg.returnCode);
    fireEvent.click(
      screen.getByRole("checkbox", {
        name: "Let these sites in again: https://a.example",
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Bring them home" }));
    await screen.findByText("site grants restored");
    expect(origin.files.get(CONSENTS)).toBe(GRANTED);
  });

  it("offers to clear what a cut-short departure left", async () => {
    const packed = await packDeparture(origin.deps, { safe: [PRJ_TRIP] });
    if (!packed.ok) throw new Error(packed.code);
    const body = tombFile(PRJ_WORK, "body");
    origin.stuck.add(body);
    await completeDeparture(origin.deps, packed.pkg, ACK);
    origin.stuck.clear();

    render(<TravelPanel />);
    const clear = await screen.findByRole("button", {
      name: "Clear leftover files",
    });
    expect(
      screen.getByText("1 file · no header, never openable here"),
    ).toBeTruthy();
    fireEvent.click(clear);
    await screen.findByText("Leftovers cleared");
    expect(origin.files.has(body)).toBe(false);
    await waitFor(() =>
      expect(
        screen.queryByRole("button", { name: "Clear leftover files" }),
      ).toBeNull(),
    );
  });
});
