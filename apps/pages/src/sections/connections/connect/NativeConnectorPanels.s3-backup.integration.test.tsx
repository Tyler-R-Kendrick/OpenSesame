import { catalogProvider } from "@opensesame/app-core/lib/connector-catalog.js";
import { readDeviceRows } from "@opensesame/app-core/lib/device-connector-records.js";
import { deviceConnection } from "@opensesame/app-core/lib/device-connectors.js";
import { bindNativeProviderTransport } from "@opensesame/app-core/lib/native-connector-transport.js";
import { configureNativeS3 } from "@opensesame/app-core/lib/native-s3.js";
import { runtimePassword } from "@opensesame/app-core/lib/secret-backends/runtime.test-support.js";
import { nativeS3BackupFixture } from "@opensesame/app-core/lib/test/native-s3-backup-fixtures.js";
import { vaultStore } from "@opensesame/app-core/lib/vault/store.js";
/** @vitest-environment jsdom */
import { createItem, readVaultFile } from "@opensesame/vault-core";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { NativeConnectorPanels } from "./NativeConnectorPanels.js";

let fixture: Awaited<ReturnType<typeof nativeS3BackupFixture>>;
let unbind: () => void;
beforeEach(async () => {
  fixture = await nativeS3BackupFixture("vault %/nested/");
  unbind = bindNativeProviderTransport(fixture.transport);
});
afterEach(async () => {
  cleanup();
  unbind();
  await fixture.close();
});
function mount() {
  const provider = catalogProvider("s3");
  if (!provider) throw new Error("Missing actual S3 catalog row");
  const onFlash = vi.fn();
  const mounted = render(
    <MemoryRouter>
      <NativeConnectorPanels
        provider={provider}
        connection={deviceConnection(fixture.saved.connectionId)}
        onFlash={onFlash}
        onChanged={() => {}}
      />
    </MemoryRouter>,
  );
  return { ...mounted, onFlash };
}
async function submitBackup() {
  const form = await screen.findByRole("form", { name: "Back up vault" });
  fireEvent.submit(form);
}

it("mounts shared controls on the saved native bucket and really encrypts, uploads, reads back and imports", async () => {
  const item = createItem("secret", "Mounted native source");
  item.value = "native-mounted-plaintext-canary";
  await vaultStore.saveItem(item);
  mount();
  await submitBackup();
  const reference = await screen.findByLabelText("Saved backup ID");
  const id = reference.getAttribute("value") ?? "";
  expect(id).toMatch(/^backups\/.+\.json$/);
  const stored = fixture.objects.get(`/test-bucket/vault %/nested/${id}`);
  expect(stored).toBeDefined();
  expect(stored?.toString("utf8")).not.toContain(item.value);
  expect(readVaultFile(stored?.toString("utf8") ?? "").header).toBeTruthy();
  expect(fixture.requests.map((row) => row.method)).toEqual([
    "GET",
    "PUT",
    "GET",
  ]);
  expect(fixture.requests[1]?.conditional).toBe("*");
  await vaultStore.trashItem(item.id);
  await vaultStore.purgeItem(item.id);
  const later = createItem("note", "Keep later local item");
  await vaultStore.saveItem(later);
  fireEvent.change(screen.getByLabelText("Backup name or ID"), {
    target: { value: id },
  });
  fireEvent.change(screen.getByLabelText("Backup password or PIN"), {
    target: { value: runtimePassword },
  });
  fireEvent.submit(screen.getByRole("form", { name: "Restore vault backup" }));
  expect(screen.getByLabelText("Backup password or PIN")).toHaveProperty(
    "value",
    "",
  );
  await waitFor(() =>
    expect(vaultStore.getSnapshot().items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: item.id, value: item.value }),
        expect.objectContaining({ id: later.id }),
      ]),
    ),
  );
  await screen.findByRole("img", {
    name: "1 items restored from encrypted backup",
  });
  expect(fixture.requests.map((row) => row.method)).toEqual([
    "GET",
    "PUT",
    "GET",
    "GET",
  ]);
  expect(JSON.stringify(readDeviceRows())).not.toContain(
    "fixture-private-signing-secret",
  );
});

it.each(["unmount", "provider", "vault", "replacement"] as const)(
  "withdraws a genuinely held PUT on %s without readback or a late success",
  async (withdrawal) => {
    const item = createItem("note", "Held backup source");
    await vaultStore.saveItem(item);
    fixture.hold("PUT");
    const mounted = mount();
    await submitBackup();
    await waitFor(() => expect(fixture.held()?.method).toBe("PUT"));
    if (withdrawal === "unmount") mounted.unmount();
    else if (withdrawal === "provider") fixture.provider.abort();
    else if (withdrawal === "vault") vaultStore.lock();
    else
      await configureNativeS3(
        {
          ...fixture.draft,
          connectionId: fixture.saved.connectionId,
          revision: fixture.saved.revision,
          displayName: "Replaced native bucket",
          credentials: {},
        },
        fixture.transport,
      );
    await waitFor(() =>
      expect(fixture.held()).toMatchObject({ closed: true, premature: true }),
    );
    expect(fixture.requests.map((row) => row.method)).toEqual(
      withdrawal === "replacement" ? ["GET", "PUT", "GET"] : ["GET", "PUT"],
    );
    expect(
      fixture.requests
        .filter((row) => row.method === "GET")
        .every((row) => row.path === "/test-bucket/"),
    ).toBe(true);
    expect(mounted.onFlash).not.toHaveBeenCalledWith(
      expect.objectContaining({ tone: "ok" }),
    );
    expect(screen.queryByLabelText("Saved backup ID")).toBeNull();
  },
);
