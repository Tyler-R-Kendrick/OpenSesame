/** @vitest-environment jsdom */
import { catalogProvider } from "@opensesame/app-core/lib/connector-catalog.js";
import { readDeviceRows } from "@opensesame/app-core/lib/device-connector-records.js";
import { deviceConnection } from "@opensesame/app-core/lib/device-connectors.js";
import { readNativeConnector } from "@opensesame/app-core/lib/native-connector-store.js";
import { configureNativeS3 } from "@opensesame/app-core/lib/native-s3.js";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { expect, it, vi } from "vitest";
import { ConnectorSettingsPage } from "../SettingsPage.js";
import {
  catalogConnectorAction,
  preferredCatalogConnection,
} from "../catalog-connector-action.js";
import { declareConnectionsTutorial } from "../tutorial.test-support.js";
import { NativeConnectorPanels } from "./NativeConnectorPanels.js";
import {
  connectorIntegration,
  installConnectorIntegration,
} from "./native-connector-integration.test-support.js";
import { nativeS3Descriptor } from "./native-s3-descriptor.js";

declareConnectionsTutorial();
installConnectorIntegration();
const found = catalogProvider("s3");
if (!found) throw new Error("S3 catalog row required");
const provider = found;
const xml =
  '<ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Name>test-bucket</Name><Prefix/><IsTruncated>false</IsTruncated><Contents><Key>sealed/document</Key></Contents></ListBucketResult>';

it("keeps S3 in its native authentication owner when its browser driver is unavailable", () => {
  const descriptor = nativeS3Descriptor(provider, false);
  expect(descriptor.methods[0]).toMatchObject({
    id: "api-key",
    available: false,
  });
  expect(catalogConnectorAction(provider, null)).toMatchObject({
    kind: "native",
    glyph: "computer",
  });
  render(
    <MemoryRouter>
      <ConnectorSettingsPage
        provider={provider}
        providerId="s3"
        connection={null}
        connections={[]}
        loading={false}
        online
        canConfigure
        configureHint=""
        flash={null}
        rememberOffer={null}
        onFlash={vi.fn()}
        onRememberOffer={vi.fn()}
        onChanged={vi.fn()}
      />
    </MemoryRouter>,
  );
  expect(
    screen.getByRole("img", {
      name: `${provider.displayName} has no supported browser connection method.`,
    }),
  ).toBeTruthy();
  expect(
    screen.queryByRole("button", { name: "Save configuration" }),
  ).toBeNull();
  expect(screen.queryByLabelText("S3 HTTPS service origin")).toBeNull();
  expect(screen.queryByLabelText("Connector name")).toBeNull();
});

it("disables provider operations for a saved S3 binding after its driver is deactivated", async () => {
  const fixture = connectorIntegration();
  fixture.route.respond = async () => new Response(xml);
  const saved = await configureNativeS3({
    providerId: "s3",
    displayName: "Verified bucket",
    parameters: {
      endpoint: "https://minio.example.test",
      region: "us-east-1",
      bucket: "test-bucket",
      access_key_id: "public-key-id",
    },
    credentials: { secret_access_key: "private-signing-key" },
  });
  const connection = deviceConnection(saved.connectionId);
  if (!connection) throw new Error("Verified bucket required");
  fixture.activation.dispose();
  render(
    <MemoryRouter>
      <NativeConnectorPanels
        provider={provider}
        connection={connection}
        onFlash={vi.fn()}
        onChanged={vi.fn()}
      />
    </MemoryRouter>,
  );
  expect(
    screen.getByRole("button", { name: "Verify S3-compatible bucket access" }),
  ).toHaveProperty("disabled", true);
  await userEvent.click(
    screen.getByText("Check S3-compatible bucket access", {
      selector: "summary",
    }),
  );
  expect(
    screen.getByRole("button", { name: "Check S3-compatible bucket access" }),
  ).toHaveProperty("disabled", true);
  await userEvent.click(
    screen.getByText("List object keys", { selector: "summary" }),
  );
  expect(
    screen.getByRole("button", { name: "List object keys" }),
  ).toHaveProperty("disabled", true);
  expect(fixture.requests).toHaveLength(1);
});

it("uses a signed bucket permission check and prefers its verified binding over a legacy saved row", async () => {
  const fixture = connectorIntegration();
  const replies = [
    new Response("denied", { status: 403 }),
    new Response(xml),
    new Response(xml),
  ];
  fixture.route.respond = async () => {
    const reply = replies.shift();
    if (!reply) throw new Error("No S3 fixture response");
    return reply;
  };
  const onFlash = vi.fn();
  render(
    <MemoryRouter>
      <NativeConnectorPanels
        provider={provider}
        connection={null}
        onFlash={onFlash}
        onChanged={vi.fn()}
      />
    </MemoryRouter>,
  );
  expect(screen.queryByLabelText("Connector name")).toBeNull();
  for (const [label, value] of [
    ["S3 HTTPS service origin", "https://minio.example.test"],
    ["Bucket", "test-bucket"],
    ["Access key ID", "public-key-id"],
    ["Secret access key", "private-signing-key"],
  ])
    await userEvent.type(screen.getByLabelText(label), value);
  await userEvent.click(
    screen.getByRole("button", {
      name: "Verify and connect S3-compatible bucket",
    }),
  );
  await waitFor(() =>
    expect(onFlash).toHaveBeenCalledWith(
      expect.objectContaining({ tone: "err" }),
    ),
  );
  expect(readDeviceRows()).toEqual([]);
  await userEvent.click(
    screen.getByRole("button", {
      name: "Verify and connect S3-compatible bucket",
    }),
  );
  await waitFor(() => expect(readDeviceRows()).toHaveLength(1));
  const row = readDeviceRows()[0];
  if (!row) throw new Error("Verified bucket required");
  expect(readNativeConnector(row.connectionId)).toMatchObject({
    status: "connected",
    identity: { kind: "bucket", assurance: "credential-valid" },
  });
  expect(
    new Headers(fixture.requests[1]?.headers).get("Authorization"),
  ).toMatch(/^AWS4-HMAC-SHA256 /);
  await userEvent.click(
    screen.getByText("List object keys", { selector: "summary" }),
  );
  await userEvent.click(
    screen.getByRole("button", { name: "List object keys" }),
  );
  await waitFor(() => expect(screen.getByText("sealed/document")).toBeTruthy());
  const connection = deviceConnection(row.connectionId);
  if (!connection) throw new Error("Verified connection required");
  const legacy = {
    ...connection,
    connectionId: "s3_legacy_configuration",
    connectionRef: "s3://configured",
  };
  expect(catalogConnectorAction(provider, legacy).kind).not.toBe("configure");
  expect(preferredCatalogConnection(provider, [legacy, connection])).toBe(
    connection,
  );
  expect(catalogConnectorAction(provider, connection)).toMatchObject({
    kind: "configure",
    glyph: "ellipsis",
    connectionId: connection.connectionId,
  });
  expect([...fixture.disk.files.values()].join()).not.toContain(
    "private-signing-key",
  );
});
