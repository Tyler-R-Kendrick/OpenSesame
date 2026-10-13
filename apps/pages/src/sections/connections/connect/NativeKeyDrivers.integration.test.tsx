import { catalogProvider } from "@opensesame/app-core/lib/connector-catalog.js";
import { readDeviceRows } from "@opensesame/app-core/lib/device-connector-records.js";
import { fakeAcme } from "@opensesame/app-core/lib/native-acme.test-support.js";
import {
  loadNativeConnectorRecord,
  readNativeConnector,
} from "@opensesame/app-core/lib/native-connector-store.js";
/** @vitest-environment jsdom */
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { expect, it, vi } from "vitest";
import { catalogConnectorAction } from "../catalog-connector-action.js";
import { declareConnectionsTutorial } from "../tutorial.test-support.js";
import { NativeConnectorPanels } from "./NativeConnectorPanels.js";
import {
  connectorIntegration,
  installConnectorIntegration,
} from "./native-connector-integration.test-support.js";

declareConnectionsTutorial();
installConnectorIntegration();

function provider(id: string) {
  const found = catalogProvider(id);
  if (!found) throw new Error(`Catalog row required: ${id}`);
  return { ...found, id };
}

it("draws a connect road for every provider that connects with the person's own key", () => {
  connectorIntegration();
  for (const id of ["aws-sts", "azure-ac", "gcp", "gcp-iam", "letsencrypt"])
    expect(catalogConnectorAction(provider(id), null), id).toMatchObject({
      kind: "connect",
      method: "api-key",
    });
});

it("connects Let's Encrypt from its form: a choice, an agreement, a signed registration, then an order", async () => {
  const fixture = connectorIntegration();
  const ca = fakeAcme({ publish: true });
  fixture.route.respond = async (request) =>
    ca.fetch(request.url, {
      method: request.method,
      headers: request.headers,
      body: request.method === "POST" ? await request.text() : undefined,
    });
  render(
    <MemoryRouter>
      <NativeConnectorPanels
        provider={provider("letsencrypt")}
        connection={null}
        onFlash={vi.fn()}
        onChanged={vi.fn()}
      />
    </MemoryRouter>,
  );
  // No key is asked for: the account key is made in this page.
  expect(screen.queryByLabelText(/key|secret|password/i)).toBeNull();
  await userEvent.selectOptions(
    screen.getByLabelText("Environment"),
    "staging",
  );
  await userEvent.selectOptions(
    screen.getByLabelText("Subscriber Agreement"),
    "yes",
  );
  await userEvent.click(
    screen.getByRole("button", { name: "Verify and connect Let's Encrypt" }),
  );
  await waitFor(() => expect(readDeviceRows()).toHaveLength(1));
  const row = readDeviceRows()[0];
  if (!row) throw new Error("Verified connection required");
  expect(readNativeConnector(row.connectionId)).toMatchObject({
    status: "connected",
    identity: { kind: "acme-account", assurance: "credential-valid" },
  });
  // The CA checked the signature on the registration; the key is sealed, not on disk.
  expect(ca.accounts.size).toBe(1);
  const key = loadNativeConnectorRecord(row.connectionId)?.privateState
    .credentials.account_key;
  expect(key).toContain('"d"');
  expect([...fixture.disk.files.values()].join()).not.toContain(
    JSON.parse(key ?? "{}").d,
  );

  await userEvent.click(
    screen.getByText("Open an order and get the DNS records", {
      selector: "summary",
    }),
  );
  await userEvent.type(screen.getByLabelText("DNS names"), "example.org");
  await userEvent.click(
    screen.getByRole("button", {
      name: "Open an order and get the DNS records",
    }),
  );
  await waitFor(() =>
    expect(screen.getByText("TXT _acme-challenge.example.org")).toBeTruthy(),
  );
  expect(ca.orders.size).toBe(1);
});
