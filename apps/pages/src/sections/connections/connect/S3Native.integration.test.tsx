/** @vitest-environment jsdom */
import { catalogProvider } from "@opensesame/app-core/lib/connector-catalog.js";
import { readDeviceRows } from "@opensesame/app-core/lib/device-connector-records.js";
import { deviceConnection } from "@opensesame/app-core/lib/device-connectors.js";
import { readNativeConnector } from "@opensesame/app-core/lib/native-connector-store.js";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { expect, it, vi } from "vitest";
import {
  catalogConnectorAction,
  preferredCatalogConnection,
} from "../catalog-connector-action.js";
import { NativeConnectorPanels } from "./NativeConnectorPanels.js";
import {
  connectorIntegration,
  installConnectorIntegration,
} from "./native-connector-integration.test-support.js";

installConnectorIntegration();
const found = catalogProvider("s3");
if (!found) throw new Error("S3 catalog row required");
const provider = found;
const xml =
  '<ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Name>test-bucket</Name><Prefix/><IsTruncated>false</IsTruncated><Contents><Key>sealed/document</Key></Contents></ListBucketResult>';

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
