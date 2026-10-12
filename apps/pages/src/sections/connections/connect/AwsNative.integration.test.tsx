import { catalogProvider } from "@opensesame/app-core/lib/connector-catalog.js";
import { readDeviceRows } from "@opensesame/app-core/lib/device-connector-records.js";
import { deviceConnection } from "@opensesame/app-core/lib/device-connectors.js";
import { readNativeConnector } from "@opensesame/app-core/lib/native-connector-store.js";
/** @vitest-environment jsdom */
import type { BoundaryValue } from "@opensesame/os-domain";
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

function aws(id: string) {
  const found = catalogProvider(id);
  if (!found) throw new Error(`AWS catalog row required: ${id}`);
  return found;
}
const json = (body: BoundaryValue, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/x-amz-json-1.1" },
  });

it("offers AWS Secrets Manager as a browser connection, not a companion", () => {
  connectorIntegration();
  // The tile connects: the page this used to say "cannot run that companion".
  expect(catalogConnectorAction(aws("aws"), null)).toMatchObject({
    kind: "connect",
    glyph: "plus",
    method: "api-key",
  });
  expect(catalogConnectorAction(aws("aws-ps"), null)).toMatchObject({
    kind: "connect",
    method: "api-key",
  });
  // AWS STS has no driver yet, and says so.
  expect(catalogConnectorAction(aws("aws-sts"), null)).toMatchObject({
    kind: "unavailable",
    reason: "driver-pending",
  });
});

it("verifies a signed Secrets Manager list, then lists names and reads one value once", async () => {
  const fixture = connectorIntegration();
  const replies = [
    json({ SecretList: [{ Name: "prod/db" }] }),
    json({ SecretList: [{ Name: "prod/db" }] }),
    json({ SecretString: "hunter2-value" }),
  ];
  fixture.route.respond = async () => {
    const reply = replies.shift();
    if (!reply) throw new Error("No AWS fixture response");
    return reply;
  };
  const onFlash = vi.fn();
  render(
    <MemoryRouter>
      <NativeConnectorPanels
        provider={aws("aws")}
        connection={null}
        onFlash={onFlash}
        onChanged={vi.fn()}
      />
    </MemoryRouter>,
  );
  expect(screen.getByLabelText("Region")).toHaveProperty("value", "us-east-1");
  expect(screen.queryByLabelText(/endpoint|origin/i)).toBeNull();
  for (const [label, value] of [
    ["Access key ID", "AKIAIOSFODNN7EXAMPLE"],
    ["Secret access key", "private-signing-key"],
  ])
    await userEvent.type(screen.getByLabelText(label), value);
  await userEvent.click(
    screen.getByRole("button", {
      name: "Verify and connect AWS Secrets Manager",
    }),
  );
  await waitFor(() => expect(readDeviceRows()).toHaveLength(1));
  const row = readDeviceRows()[0];
  if (!row) throw new Error("Verified connection required");
  expect(readNativeConnector(row.connectionId)).toMatchObject({
    status: "connected",
    identity: { kind: "region", assurance: "credential-valid" },
  });
  const request = fixture.requests[0];
  expect(request?.url).toBe("https://secretsmanager.us-east-1.amazonaws.com/");
  expect(new Headers(request?.headers).get("Authorization")).toMatch(
    /^AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE\/\d{8}\/us-east-1\/secretsmanager\/aws4_request/,
  );
  expect(new Headers(request?.headers).get("x-amz-target")).toBe(
    "secretsmanager.ListSecrets",
  );
  // The key was sealed, and the form no longer holds it.
  expect(screen.getByLabelText("Secret access key")).toHaveProperty(
    "value",
    "",
  );
  expect([...fixture.disk.files.values()].join()).not.toContain(
    "private-signing-key",
  );

  await userEvent.click(
    screen.getByText("List secret names", { selector: "summary" }),
  );
  await userEvent.click(
    screen.getByRole("button", { name: "List secret names" }),
  );
  await waitFor(() => expect(screen.getByText("prod/db")).toBeTruthy());

  await userEvent.click(
    screen.getByText("Read a secret value", { selector: "summary" }),
  );
  await userEvent.type(screen.getByLabelText("Secret name"), "prod/db");
  await userEvent.click(
    screen.getByRole("button", { name: "Read a secret value" }),
  );
  await waitFor(() => expect(fixture.requests).toHaveLength(3));
  expect(new Headers(fixture.requests[2]?.headers).get("x-amz-target")).toBe(
    "secretsmanager.GetSecretValue",
  );
  // The value is shown on request and is not on disk.
  expect([...fixture.disk.files.values()].join()).not.toContain(
    "hunter2-value",
  );
  const connection = deviceConnection(row.connectionId);
  expect(
    connection && catalogConnectorAction(aws("aws"), connection),
  ).toMatchObject({
    kind: "configure",
  });
});

it("says a refused key is refused, saves nothing, and never echoes what AWS wrote", async () => {
  const fixture = connectorIntegration();
  fixture.route.respond = async () =>
    json(
      {
        __type: "UnrecognizedClientException",
        message: "echo: arn:aws:iam::123456789012:user/secret-owner",
      },
      400,
    );
  const onFlash = vi.fn();
  render(
    <MemoryRouter>
      <NativeConnectorPanels
        provider={aws("aws-ps")}
        connection={null}
        onFlash={onFlash}
        onChanged={vi.fn()}
      />
    </MemoryRouter>,
  );
  for (const [label, value] of [
    ["Access key ID", "AKIAIOSFODNN7EXAMPLE"],
    ["Secret access key", "wrong-key"],
  ])
    await userEvent.type(screen.getByLabelText(label), value);
  await userEvent.click(
    screen.getByRole("button", {
      name: "Verify and connect AWS Parameter Store",
    }),
  );
  await waitFor(() =>
    expect(onFlash).toHaveBeenCalledWith(
      expect.objectContaining({ tone: "err" }),
    ),
  );
  const shown = JSON.stringify(onFlash.mock.calls);
  expect(shown).toContain("authorization was refused");
  expect(shown).not.toContain("secret-owner");
  expect(readDeviceRows()).toEqual([]);
  expect(new Headers(fixture.requests[0]?.headers).get("x-amz-target")).toBe(
    "AmazonSSM.DescribeParameters",
  );
});
