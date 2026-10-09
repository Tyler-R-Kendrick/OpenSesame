import { readDeviceRows } from "@opensesame/app-core/lib/device-connector-records.js";
/** @vitest-environment jsdom */
import { deviceConnection } from "@opensesame/app-core/lib/device-connectors.js";
import { configureNativeApiConnector } from "@opensesame/app-core/lib/native-api-connectors.js";
import { readNativeConnector } from "@opensesame/app-core/lib/native-connector-store.js";
import type { BoundaryValue } from "@opensesame/os-domain";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { expect, it, vi } from "vitest";
import { NativeConnectorPanels } from "./NativeConnectorPanels.js";
import {
  connectorIntegration,
  installConnectorIntegration,
  integrationProvider,
} from "./native-connector-integration.test-support.js";
installConnectorIntegration();
type ProviderCase = {
  id: string;
  name: string;
  fields: readonly (readonly [string, string])[];
  parameters: readonly (readonly [string, string])[];
  response: BoundaryValue;
  url: string;
  headers: Record<string, string>;
};
async function enterFields({ fields, parameters }: ProviderCase) {
  await userEvent.click(screen.getByRole("radio", { name: "API Key" }));
  for (const [label, value] of parameters)
    await userEvent.selectOptions(screen.getByLabelText(label), value);
  for (const [label, value] of fields)
    await userEvent.type(
      screen.getByLabelText(label, { selector: 'input[type="password"]' }),
      value,
    );
}
function assertHeaders(
  request: Request | undefined,
  headers: Record<string, string>,
) {
  for (const [header, value] of Object.entries(headers))
    expect(request?.headers.get(header)).toBe(value);
}
function assertSecretsBlank(fields: ProviderCase["fields"]) {
  for (const [label] of fields)
    expect(
      screen.getByLabelText(label, { selector: 'input[type="password"]' }),
    ).toHaveProperty("value", "");
}
function assertSecretsSealed(
  fixture: ReturnType<typeof connectorIntegration>,
  fields: ProviderCase["fields"],
) {
  for (const [, secret] of fields) {
    expect(JSON.stringify(readDeviceRows())).not.toContain(secret);
    expect([...fixture.disk.files.values()].join()).not.toContain(secret);
  }
}
const cases: ProviderCase[] = [
  {
    id: "notion",
    name: "Notion",
    fields: [["Notion API key", "private-notion-key"]],
    parameters: [],
    response: { id: "bot-1", name: "Team integration" },
    url: "https://api.notion.com/v1/users/me",
    headers: { Authorization: "Bearer private-notion-key" },
  },
];
it.each(cases)(
  "creates and edits $name with its registered driver and sealed saved credentials",
  async (provider) => {
    const { id, name, fields, response, url, headers } = provider;
    const fixture = connectorIntegration();
    fixture.replies.push({ body: response });
    const onFlash = vi.fn();
    render(
      <MemoryRouter>
        <NativeConnectorPanels
          provider={integrationProvider(id)}
          connection={null}
          onFlash={onFlash}
          onChanged={() => {}}
        />
      </MemoryRouter>,
    );
    await enterFields(provider);
    await userEvent.click(
      screen.getByRole("button", { name: `Verify and connect ${name}` }),
    );
    await waitFor(() => expect(readDeviceRows()).toHaveLength(1));
    const row = readDeviceRows()[0];
    if (!row) throw new Error("Missing saved connector");
    const first = readNativeConnector(row.connectionId);
    expect(first?.status).toBe("connected");
    expect(fixture.requests[0]?.url).toBe(url);
    assertHeaders(fixture.requests[0], headers);
    await waitFor(() =>
      expect(screen.getByLabelText("Connector name")).toHaveProperty(
        "value",
        name,
      ),
    );
    assertSecretsBlank(fields);
    fixture.replies.push({ body: response });
    await userEvent.clear(screen.getByLabelText("Connector name"));
    await userEvent.type(
      screen.getByLabelText("Connector name"),
      "Renamed provider",
    );
    await userEvent.click(
      screen.getByRole("button", { name: `Verify and connect ${name}` }),
    );
    await waitFor(() =>
      expect(readNativeConnector(row.connectionId)?.revision).toBe(
        (first?.revision ?? 0) + 1,
      ),
    );
    expect(readDeviceRows()).toHaveLength(1);
    expect(
      readNativeConnector(row.connectionId)?.configuration.displayName,
    ).toBe("Renamed provider");
    assertHeaders(fixture.requests[1], headers);
    assertSecretsSealed(fixture, fields);
    await fixture.reload();
    expect(readNativeConnector(row.connectionId)?.status).toBe("connected");
    expect(
      readNativeConnector(row.connectionId)?.configuration.displayName,
    ).toBe("Renamed provider");
    expect(onFlash.mock.calls.every(([flash]) => flash.tone === "ok")).toBe(
      true,
    );
  },
);

it("refuses an action from an old rendered revision, then accepts the newly displayed provider binding", async () => {
  const fixture = connectorIntegration();
  const response = { id: "bot-1", name: "Team integration" };
  fixture.replies.push({ body: response });
  const saved = await configureNativeApiConnector({
    providerId: "notion",
    displayName: "Initial name",
    parameters: {},
    credentials: { api_key: "private-notion-key" },
  });
  const onFlash = vi.fn();
  render(
    <MemoryRouter>
      <NativeConnectorPanels
        provider={integrationProvider("notion")}
        connection={deviceConnection(saved.connectionId)}
        onFlash={onFlash}
        onChanged={() => {}}
      />
    </MemoryRouter>,
  );
  fixture.replies.push({ body: response });
  await configureNativeApiConnector({
    providerId: "notion",
    connectionId: saved.connectionId,
    revision: saved.revision,
    displayName: "Updated in another tab",
    parameters: {},
    credentials: {},
  });
  const calls = fixture.requests.length;
  await userEvent.click(
    screen.getByRole("button", { name: "Verify Notion access" }),
  );
  await waitFor(() =>
    expect(onFlash).toHaveBeenLastCalledWith(
      expect.objectContaining({ tone: "err" }),
    ),
  );
  expect(fixture.requests).toHaveLength(calls);
  expect(screen.getByLabelText("Connector name")).toHaveProperty(
    "value",
    "Updated in another tab",
  );
  fixture.replies.push({ body: response });
  await userEvent.click(
    screen.getByRole("button", { name: "Verify Notion access" }),
  );
  await waitFor(() => expect(fixture.requests).toHaveLength(calls + 1));
  await waitFor(() =>
    expect(readNativeConnector(saved.connectionId)?.revision).toBe(
      saved.revision + 2,
    ),
  );
  expect(onFlash).toHaveBeenCalledTimes(1);
});
it("refuses blocked Datadog configuration before entering credentials, HTTP or storage", async () => {
  const fixture = connectorIntegration();
  render(
    <MemoryRouter>
      <NativeConnectorPanels
        provider={integrationProvider("datadog")}
        connection={null}
        onFlash={() => {}}
        onChanged={() => {}}
      />
    </MemoryRouter>,
  );
  expect(screen.queryByRole("radio", { name: "API Key" })).toBeNull();
  await userEvent.click(
    screen.getByText("Other sign-in methods", { selector: "summary" }),
  );
  expect(screen.getByText(/Datadog rejected browser access/)).toBeTruthy();
  expect(screen.queryByLabelText("Datadog API key")).toBeNull();
  expect(
    screen.queryByRole("button", { name: "Verify and connect Datadog" }),
  ).toBeNull();
  expect(fixture.requests).toHaveLength(0);
  expect(readDeviceRows()).toEqual([]);
});
it("keeps the saved Notion binding and credential when a replacement key fails real verification", async () => {
  const fixture = connectorIntegration();
  fixture.replies.push({ body: { id: "bot-1", name: "Team integration" } });
  const saved = await configureNativeApiConnector({
    providerId: "notion",
    displayName: "Saved Notion",
    parameters: {},
    credentials: { api_key: "private-original-key" },
  });
  render(
    <MemoryRouter>
      <NativeConnectorPanels
        provider={integrationProvider("notion")}
        connection={deviceConnection(saved.connectionId)}
        onFlash={() => {}}
        onChanged={() => {}}
      />
    </MemoryRouter>,
  );
  await userEvent.type(
    screen.getByLabelText("Notion API key", {
      selector: 'input[type="password"]',
    }),
    "private-replacement-key",
  );
  fixture.replies.push({ body: { code: "unauthorized" }, status: 401 });
  await userEvent.click(
    screen.getByRole("button", { name: "Verify and connect Notion" }),
  );
  await screen.findByRole("img", {
    name: "Provider authorization was refused; verify or replace the saved credential",
  });
  expect(fixture.requests).toHaveLength(2);
  expect(readNativeConnector(saved.connectionId)?.revision).toBe(
    saved.revision,
  );
  expect(
    readNativeConnector(saved.connectionId)?.configuration.displayName,
  ).toBe("Saved Notion");
  expect(readDeviceRows()).toHaveLength(1);
  fixture.replies.push({ body: { id: "bot-1", name: "Team integration" } });
  await userEvent.clear(
    screen.getByLabelText("Notion API key", {
      selector: 'input[type="password"]',
    }),
  );
  await userEvent.click(
    screen.getByRole("button", { name: "Verify and connect Notion" }),
  );
  await waitFor(() =>
    expect(readNativeConnector(saved.connectionId)?.revision).toBe(
      saved.revision + 1,
    ),
  );
  expect(fixture.requests[2]?.headers.get("authorization")).toBe(
    "Bearer private-original-key",
  );
});
