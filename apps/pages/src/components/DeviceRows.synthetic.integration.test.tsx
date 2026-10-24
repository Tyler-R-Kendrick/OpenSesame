/** @vitest-environment jsdom */
import {
  readDeviceRows,
  readDeviceSecrets,
  subscribeDeviceRows,
  writeDeviceRows,
  writeDeviceSecrets,
} from "@opensesame/app-core/lib/device-connector-records.js";
import { deviceConnectorDisplayName } from "@opensesame/app-core/lib/device-connector-view.js";
import { kvFlush } from "@opensesame/app-core/lib/kv.js";
import {
  runtimeFixture,
  runtimePassword,
} from "@opensesame/app-core/lib/secret-backends/runtime.test-support.js";
import { vaultStore } from "@opensesame/app-core/lib/vault/store.js";
import { act, cleanup, render, screen } from "@testing-library/react";
import { useSyncExternalStore } from "react";
import { afterEach, expect, it } from "vitest";
const id = "conn_local_synthetic-view";
function Heading() {
  const name = useSyncExternalStore(
    subscribeDeviceRows,
    () => deviceConnectorDisplayName("linear", id) ?? "Connection",
  );
  return <h1>{name}</h1>;
}
afterEach(() => {
  cleanup();
  vaultStore.lock();
});
it("invalidates an already mounted device heading across real synthetic entry and exit without deleting owner records", async () => {
  await runtimeFixture();
  await kvFlush();
  await vaultStore.flushPendingWrites();
  writeDeviceRows([
    {
      connectionId: id,
      providerId: "linear",
      displayName: "Private owner provider",
      scopes: ["owner-private"],
      fields: {},
      createdAt: "2026-10-18T00:00:00Z",
      updatedAt: "2026-10-18T00:00:00Z",
    },
  ]);
  await kvFlush();
  await vaultStore.flushPendingWrites();
  writeDeviceSecrets({ [id]: { token: "private original token" } });
  await kvFlush();
  await vaultStore.flushPendingWrites();
  await new Promise((resolve) => setTimeout(resolve, 50));
  await vaultStore.beginRetired(
    { kind: "password", secret: runtimePassword },
    {
      kind: "change",
      change: {
        type: "enroll",
        password: "retired synthetic credential browser UI",
        response: "synthetic_decoy",
      },
    },
  );
  await kvFlush();
  await vaultStore.flushPendingWrites();
  render(<Heading />);
  expect(screen.getByRole("heading").textContent).toBe(
    "Private owner provider",
  );
  await act(async () => {
    vaultStore.lock();
    await vaultStore.unlock("retired synthetic credential browser UI");
  });
  await kvFlush();
  await vaultStore.flushPendingWrites();
  expect(vaultStore.isSyntheticSession()).toBe(true);
  expect(screen.queryByText("Private owner provider")).toBeNull();
  expect(screen.getByRole("heading").textContent).toBe("Connection");
  expect(readDeviceRows()).toEqual([]);
  expect(readDeviceSecrets()).toEqual({});
  await act(async () => vaultStore.lock());
  expect(screen.getByRole("heading").textContent).toBe(
    "Private owner provider",
  );
  expect(readDeviceSecrets()[id]?.token).toBe("private original token");
});
