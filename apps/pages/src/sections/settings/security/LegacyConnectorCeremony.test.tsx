import { persistentBrowserOwner } from "@opensesame/app-core/browser/security-integration/management-host.fixture.js";
import {
  LEGACY_CONNECTOR_PUBLIC_KEY,
  LEGACY_CONNECTOR_SECRET_KEY,
} from "@opensesame/app-core/lib/device-connector-legacy-storage.js";
import { legacyDeviceConnectorStatus } from "@opensesame/app-core/lib/device-connector-legacy.js";
import { readDeviceSecrets } from "@opensesame/app-core/lib/device-connector-records.js";
import {
  kvFlush,
  kvForgetAll,
  kvGet,
  kvSetDurable,
} from "@opensesame/app-core/lib/kv.js";
import { vaultStore } from "@opensesame/app-core/lib/vault/store.js";
/** @vitest-environment jsdom */
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import LegacyConnectorCeremony, {
  legacyConnectorUiPorts,
} from "./LegacyConnectorCeremony.js";
const original = { ...legacyConnectorUiPorts };
const A = "legacy_selected_a";
const B = "legacy_preserved_b";
afterEach(async () => {
  cleanup();
  vaultStore.lock();
  await kvFlush();
  kvForgetAll();
  Object.assign(legacyConnectorUiPorts, original);
  vi.unstubAllGlobals();
});
async function owner() {
  const fixture = await persistentBrowserOwner();
  await vaultStore.unlock(fixture.password);
  const stamp = new Date().toISOString();
  await kvSetDurable(
    LEGACY_CONNECTOR_PUBLIC_KEY,
    JSON.stringify(
      [A, B].map((connectionId) => ({
        connectionId,
        providerId: "anthropic",
        displayName: connectionId,
        scopes: [],
        fields: {},
        createdAt: stamp,
        updatedAt: stamp,
      })),
    ),
  );
  await kvSetDurable(
    LEGACY_CONNECTOR_SECRET_KEY,
    JSON.stringify({
      [A]: { credential: "static-legacy-fixture-a" },
      [B]: { credential: "static-legacy-fixture-b" },
    }),
  );
  return fixture;
}
function acknowledge() {
  fireEvent.click(
    screen.getByLabelText(/I understand original ownership cannot be proven/),
  );
}
it("requires explicit selected ownership consent and actual fresh password, then imports only selected records", async () => {
  const fixture = await owner();
  render(<LegacyConnectorCeremony tomb="personal" onResolved={() => {}} />);
  const selected = await screen.findByLabelText(new RegExp(A));
  expect(screen.queryByText(/static-legacy-fixture/)).toBeNull();
  fireEvent.click(selected);
  fireEvent.change(screen.getByLabelText("Current vault password"), {
    target: { value: "incorrect-owner-password" },
  });
  expect(
    screen.getByRole("button", { name: "Import selected legacy records" }),
  ).toHaveProperty("disabled", true);
  acknowledge();
  fireEvent.click(
    screen.getByRole("button", { name: "Import selected legacy records" }),
  );
  await waitFor(() =>
    expect(screen.getByLabelText("Current vault password")).toHaveProperty(
      "value",
      "",
    ),
  );
  expect(readDeviceSecrets()[A]).toBeUndefined();
  expect(kvGet(LEGACY_CONNECTOR_SECRET_KEY)).toContain(
    "static-legacy-fixture-a",
  );
  fireEvent.change(screen.getByLabelText("Current vault password"), {
    target: { value: fixture.password },
  });
  fireEvent.click(
    screen.getByRole("button", { name: "Import selected legacy records" }),
  );
  await waitFor(() =>
    expect(
      legacyDeviceConnectorStatus().records.map((row) => row.connectionId),
    ).toEqual([B]),
  );
  expect(readDeviceSecrets()[A]?.credential).toBe("static-legacy-fixture-a");
  expect(kvGet(LEGACY_CONNECTOR_SECRET_KEY)).toContain(
    "static-legacy-fixture-b",
  );
  expect(screen.queryByText(/static-legacy-fixture/)).toBeNull();
});
it("explicit discard removes only checked legacy records without importing their authority", async () => {
  const fixture = await owner();
  const complete = vi.fn();
  render(<LegacyConnectorCeremony tomb="personal" onResolved={complete} />);
  fireEvent.click(await screen.findByLabelText(new RegExp(A)));
  fireEvent.change(screen.getByLabelText("Selected record action"), {
    target: { value: "discard" },
  });
  fireEvent.change(screen.getByLabelText("Current vault password"), {
    target: { value: fixture.password },
  });
  acknowledge();
  fireEvent.click(
    screen.getByRole("button", { name: "Discard selected legacy records" }),
  );
  await waitFor(() =>
    expect(
      legacyDeviceConnectorStatus().records.map((row) => row.connectionId),
    ).toEqual([B]),
  );
  expect(readDeviceSecrets()[A]).toBeUndefined();
  expect(complete).not.toHaveBeenCalled();
});
it("does not transfer held owner intent across a real same-tomb lock and fresh unlock", async () => {
  const fixture = await owner();
  const api = await original.load();
  let finish: (value: typeof api) => void = () => {
    throw new Error("Missing loader");
  };
  const pending = new Promise<typeof api>((resolve) => {
    finish = resolve;
  });
  let loads = 0;
  legacyConnectorUiPorts.load = () =>
    ++loads === 1 ? Promise.resolve(api) : pending;
  render(<LegacyConnectorCeremony tomb="personal" onResolved={() => {}} />);
  fireEvent.click(await screen.findByLabelText(new RegExp(A)));
  fireEvent.change(screen.getByLabelText("Current vault password"), {
    target: { value: fixture.password },
  });
  acknowledge();
  fireEvent.click(
    screen.getByRole("button", { name: "Import selected legacy records" }),
  );
  vaultStore.lock();
  await vaultStore.unlock(fixture.password);
  finish(api);
  await waitFor(() =>
    expect(screen.getByLabelText("Current vault password")).toHaveProperty(
      "value",
      "",
    ),
  );
  expect(readDeviceSecrets()[A]).toBeUndefined();
  expect(
    legacyDeviceConnectorStatus().records.map((row) => row.connectionId),
  ).toEqual([A, B]);
});
it("offers separately acknowledged fresh-owner discard of irrecoverable legacy data while preserving imported root records", async () => {
  const fixture = await owner();
  const api = await original.load();
  await api.resolveLegacyDeviceConnectors({
    tomb: "personal",
    currentPassword: fixture.password,
    connectionIds: [A],
    decision: "import",
    acknowledgeOwnershipAmbiguity: true,
  });
  await kvSetDurable(LEGACY_CONNECTOR_SECRET_KEY, "invalid-legacy-fixture");
  const complete = vi.fn();
  render(<LegacyConnectorCeremony tomb="personal" onResolved={complete} />);
  const confirm = await screen.findByLabelText(
    "I explicitly confirm permanent loss of all unreadable legacy secret records.",
  );
  const discard = screen.getByRole("button", {
    name: "Discard unreadable legacy secret records",
  });
  fireEvent.change(screen.getByLabelText("Current vault password"), {
    target: { value: fixture.password },
  });
  expect(discard).toHaveProperty("disabled", true);
  fireEvent.click(confirm);
  fireEvent.click(discard);
  await waitFor(() => expect(complete).toHaveBeenCalledOnce());
  expect(legacyDeviceConnectorStatus().pending).toBe(false);
  expect(readDeviceSecrets()[A]?.credential).toBe("static-legacy-fixture-a");
  expect(screen.queryByText(/static-legacy-fixture/)).toBeNull();
});
