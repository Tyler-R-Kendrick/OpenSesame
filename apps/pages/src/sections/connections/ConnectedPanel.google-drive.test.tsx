/** @vitest-environment jsdom */
import { listDeviceConnections } from "@opensesame/app-core/lib/device-connectors.js";
import { saveModelFixture } from "@opensesame/app-core/lib/hosted-model.test-support.js";
import {
  readNativeConnector,
  updateNativeConnector,
} from "@opensesame/app-core/lib/native-connector-store.js";
import { catalogTileNote } from "@opensesame/app-core/lib/vercel-connect-catalog.js";
import { cleanup, render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { expect, it } from "vitest";
import { ConnectedPanel } from "./ConnectedPanel.js";
import {
  connectorIntegration,
  installConnectorIntegration,
  integrationProvider,
} from "./connect/native-connector-integration.test-support.js";
import { declareConnectionsTutorial } from "./tutorial.test-support.js";

installConnectorIntegration();
declareConnectionsTutorial();

const classification = {
  publicParameters: ["token_endpoint", "resource"],
  privateCredentials: ["api_key"],
};

async function oidcGoogleDrive() {
  const id = await saveModelFixture("google-drive");
  const saved = readNativeConnector(id);
  if (!saved) throw new Error("Missing Google Drive native record");
  await updateNativeConnector(id, saved, classification, (record) => {
    record.configuration.method = "oauth";
    record.configuration.parameters = {
      token_endpoint: "https://oauth2.googleapis.com/token",
      resource: "https://www.googleapis.com/oauth2/v3/userinfo",
    };
    record.configuration.requestedScopes = { user: ["openid", "email"] };
    const grant = record.privateState.grants.app;
    if (!grant) throw new Error("Missing Google Drive grant");
    record.privateState.grants = {
      user: {
        ...grant,
        actor: "user",
        kind: "oauth",
        scopes: ["openid", "email"],
      },
    };
    record.runtime.grants = record.runtime.grants.map((metadata) => ({
      ...metadata,
      actor: "user",
      permissionState: "known",
      grantedScopes: ["openid", "email"],
    }));
    record.runtime.identity = {
      id: "google-account",
      label: "Google account",
      kind: "account",
      assurance: "credential-valid",
    };
    return record;
  });
  const changed = readNativeConnector(id);
  if (!changed) throw new Error("Missing changed Google Drive record");
  await updateNativeConnector(id, changed, classification, (record) => {
    record.privateState.verification = {
      fingerprint: record.configuration.fingerprint,
      verifiedAt: 100,
      kind: "provider",
    };
    record.runtime.verifiedAt = 100;
    record.runtime.grants = record.runtime.grants.map((grant) => ({
      ...grant,
      needsReauth: false,
    }));
    return record;
  });
  const connection = listDeviceConnections().find(
    (candidate) => candidate.connectionId === id,
  );
  if (!connection) throw new Error("Missing projected Google Drive connection");
  expect(readNativeConnector(id)?.status).toBe("connected");
  expect(connection.status).toBe("active");
  return connection;
}

function connectedPanel() {
  const panel = screen
    .getByRole("heading", { name: "Connected" })
    .closest("section");
  if (!panel) throw new Error("Missing Connected section");
  return within(panel);
}

it("labels an OIDC-only Google Drive proof without claiming Drive access", async () => {
  const fixture = connectorIntegration();
  const connection = await oidcGoogleDrive();
  const provider = integrationProvider("google-drive");
  expect(catalogTileNote(provider, connection)).toEqual({
    label: "Account verified",
    tone: "chip--ok",
  });
  render(
    <MemoryRouter>
      <ConnectedPanel
        connections={[connection]}
        providers={[provider]}
        loading={false}
        setupRequired={false}
      />
    </MemoryRouter>,
  );
  expect(
    connectedPanel().getByRole("img", { name: "Account verified" }),
  ).toBeTruthy();
  expect(
    connectedPanel().getByText(
      "Google account verified; Drive access was not checked.",
    ),
  ).toBeTruthy();
  expect(connectedPanel().queryByRole("img", { name: "Connected" })).toBeNull();
  expect(fixture.requests).toHaveLength(0);
  cleanup();
});
