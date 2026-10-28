import { aiConnectionDraft } from "@opensesame/app-core/lib/ai-connections/presets.js";
import {
  deleteAiConnection,
  saveAiConnection,
} from "@opensesame/app-core/lib/ai-connections/runtime.js";
import { bindAiConnectionTransport } from "@opensesame/app-core/lib/ai-connections/transport.js";
import type { Provider } from "@opensesame/app-core/lib/connections.js";
import { catalogProvider } from "@opensesame/app-core/lib/connector-catalog.js";
import { readDeviceRows } from "@opensesame/app-core/lib/device-connector-records.js";
import { deviceConnectorView } from "@opensesame/app-core/lib/device-connector-view.js";
import { deviceConnection } from "@opensesame/app-core/lib/device-connectors.js";
import {
  modelMemoryBackend,
  saveModelFixture,
} from "@opensesame/app-core/lib/hosted-model.test-support.js";
import { kvForgetAll } from "@opensesame/app-core/lib/kv.js";
import {
  readNativeConnector,
  updateNativeConnector,
} from "@opensesame/app-core/lib/native-connector-store.js";
import { runtimeFixture } from "@opensesame/app-core/lib/secret-backends/runtime.test-support.js";
import { vaultStore } from "@opensesame/app-core/lib/vault/store.js";
import { connectorCeremonyRoot } from "@opensesame/app-core/sections/connections/shared.js";
import { cleanup, render } from "@testing-library/react";
import { MemoryRouter } from "react-router";
/** @vitest-environment jsdom */
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createActivation } from "../../modules/activation.js";
import { bindNativeRuntime } from "../../modules/connectors.external/native-runtime.js";
import { createTestContext } from "../../modules/test-context.js";
import { ConnectorSettingsPage } from "./SettingsPage.js";
import { nativeConnectorHeaderStatus } from "./SettingsPageNativeStatus.js";
import { AuthorizedAccount } from "./SettingsPageStatus.js";
import { declareConnectionsTutorial } from "./tutorial.test-support.js";

const provider: Provider = {
  id: "algolia",
  displayName: "Algolia",
  category: "developer",
  authKind: "api_key",
  docsUrl: "https://www.algolia.com/doc/",
  supportsRefresh: false,
  configured: true,
  autoConfigurable: false,
  missingConfig: [],
  callbackUrl: null,
  scopes: [],
  egress: { scheme: "https", authorities: [], pathPrefixes: [] },
  operations: [],
};
const classification = {
  publicParameters: [],
  privateCredentials: ["api_key"],
};
const disposers: (() => void)[] = [];
declareConnectionsTutorial();
beforeEach(() => {
  kvForgetAll();
  modelMemoryBackend();
});
afterEach(() => {
  cleanup();
  for (const dispose of disposers.splice(0).reverse()) dispose();
  vi.restoreAllMocks();
});

function draw(connectionId: string) {
  const row = readDeviceRows().find(
    (candidate) => candidate.connectionId === connectionId,
  );
  if (!row) throw new Error("Missing native header fixture");
  const connection = deviceConnectorView(row);
  const result = render(
    <MemoryRouter initialEntries={["/settings/connections/algolia"]}>
      <ConnectorSettingsPage
        provider={provider}
        providerId={provider.id}
        connection={connection}
        connections={[connection]}
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
  const header = result.container.querySelector("header.conn-settings__head");
  if (!header) throw new Error("Missing connector page header");
  return { header, connection };
}
function activate() {
  const test = createTestContext();
  const activation = createActivation(test.ctx, "connectors.external");
  bindNativeRuntime(test.ctx, activation);
  disposers.push(activation.dispose);
}
async function identityFixture(
  assurance: "credential-valid" | "account-verified" | "workspace-verified",
  expiresAt: number | null = null,
) {
  const id = await saveModelFixture("algolia");
  const saved = readNativeConnector(id);
  if (!saved) throw new Error("Missing native fixture");
  await updateNativeConnector(id, saved, classification, (record) => {
    record.runtime.identity = {
      id: "verified-entity",
      label: "Algolia API access verified",
      kind: "entity",
      assurance,
    };
    const grant = record.privateState.grants.app;
    const metadata = record.runtime.grants[0];
    if (!grant || !metadata) throw new Error("Missing grant fixture");
    grant.expiresAt = expiresAt;
    metadata.expiresAt = expiresAt;
    record.privateState.verification = {
      fingerprint: saved.fingerprint,
      verifiedAt: 101,
      kind: "provider",
    };
    record.runtime.verifiedAt = 101;
    return record;
  });
  return id;
}

it("does not turn an OIDC-only proof into a Google Drive access claim", async () => {
  const id = await saveModelFixture("google-drive");
  const saved = readNativeConnector(id);
  if (!saved) throw new Error("Missing Google Drive fixture");
  await updateNativeConnector(id, saved, classification, (record) => {
    record.configuration.method = "oauth";
    record.configuration.requestedScopes = { user: ["openid", "email"] };
    const grant = record.privateState.grants.app;
    if (!grant) throw new Error("Missing Google Drive grant fixture");
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
  if (!changed) throw new Error("Missing changed Google Drive fixture");
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
  expect(readNativeConnector(id)).toMatchObject({ status: "connected" });
  activate();
  const row = readDeviceRows().find(
    (candidate) => candidate.connectionId === id,
  );
  if (!row) throw new Error("Missing Google Drive native row");
  const drive = catalogProvider("google-drive");
  if (!drive) throw new Error("Missing Google Drive provider");
  const header = nativeConnectorHeaderStatus(deviceConnectorView(row), drive);
  expect(header?.sentence).toContain(
    "Google account verified; Drive access was not checked.",
  );
  expect(header?.sentence).not.toContain("Google Drive access verified");
  expect(header?.label).toBe("Account verified");
});

it("renders credential verification without inventing an account or token lifetime", async () => {
  const id = await identityFixture("credential-valid");
  activate();
  const { header, connection } = draw(id);
  expect(connection.accountLabel).toBeNull();
  expect(header.textContent).toContain("Algolia access verified.");
  expect(header.textContent).toContain(
    "The provider did not report token expiry.",
  );
  expect(header.querySelector('[role="img"]')?.getAttribute("aria-label")).toBe(
    "Access verified",
  );
  expect(header.textContent).not.toMatch(
    /Authorized as|long-lived|never expire|renews itself/i,
  );
});

it.each(["account-verified", "workspace-verified"] as const)(
  "labels actual %s facts and reports only a returned expiry",
  async (assurance) => {
    const expiry = Date.parse("2030-01-02T03:04:05.000Z");
    const id = await identityFixture(assurance, expiry);
    activate();
    const { header, connection } = draw(id);
    expect(connection.accountLabel).toBe(
      assurance === "account-verified" ? "Algolia API access verified" : null,
    );
    expect(header.textContent).toContain(
      assurance === "account-verified"
        ? "Account verified:"
        : "Workspace verified:",
    );
    expect(header.textContent).toContain(
      "Next reported token expiry: 2030-01-02T03:04:05.000Z.",
    );
    expect(header.textContent).not.toMatch(
      /long-lived|renews itself|no further sign-in/i,
    );
  },
);

it("keeps a saved native proof pending when the provider capability is inactive", async () => {
  const id = await identityFixture("credential-valid");
  const { header } = draw(id);
  expect(header.textContent).toContain(
    "Enable External connectors to verify this connection",
  );
  expect(header.querySelector('[role="img"]')?.getAttribute("aria-label")).toBe(
    "Verification pending",
  );
  expect(header.textContent).not.toMatch(
    /Algolia access verified\.|long-lived/i,
  );
});

it("uses the same truthful facts in native authorization list rows", async () => {
  const id = await identityFixture("credential-valid");
  activate();
  const row = readDeviceRows().find(
    (candidate) => candidate.connectionId === id,
  );
  if (!row) throw new Error("Missing native account row fixture");
  const connection = deviceConnectorView(row);
  const result = render(
    <MemoryRouter>
      <ul>
        <AuthorizedAccount
          connection={connection}
          provider={provider}
          ceremonyRoot={connectorCeremonyRoot("/settings/connections")}
        />
      </ul>
    </MemoryRouter>,
  );
  expect(result.container.textContent).toContain("Algolia access verified.");
  expect(result.container.textContent).toContain(
    "The provider did not report token expiry.",
  );
  expect(result.container.textContent).not.toMatch(
    /Authorized as|long-lived|renews itself/i,
  );
  expect(
    result.container.querySelector('[role="img"]')?.getAttribute("aria-label"),
  ).toBe("Access verified");
});

it.each(["endpoint", "lock", "forget"])(
  "uses current AI authority after %s despite an old active connection prop",
  async (withdraw) => {
    const fixture = await runtimeFixture();
    let allowed = true;
    const lifetime = new AbortController();
    const release = bindAiConnectionTransport({
      signal: lifetime.signal,
      assertCurrent: () => lifetime.signal.throwIfAborted(),
      assertEndpointAllowed: () => {
        if (!allowed) throw new Error("Endpoint withdrawn");
      },
      fetch: async () =>
        Response.json({ choices: [{ message: { content: "OK" } }] }),
    });
    const test = createTestContext();
    const activation = createActivation(test.ctx, "connectors.external");
    bindNativeRuntime(test.ctx, activation);
    try {
      const saved = await saveAiConnection({
        ...aiConnectionDraft("nvidia"),
        baseUrl: "https://configured-model.example/v1",
        model: "fixture-model",
        apiKey: "private-header-ai-token",
      });
      const connection = deviceConnection(saved.connectionId);
      const ai = catalogProvider("nvidia");
      if (!connection || !ai) throw new Error("Missing actual AI connection");
      expect(connection.status).toBe("active");
      expect(nativeConnectorHeaderStatus(connection, ai)).toMatchObject({
        tone: "ok",
        label: "Access verified",
      });
      if (withdraw === "endpoint") allowed = false;
      if (withdraw === "lock") vaultStore.lock();
      if (withdraw === "forget") await deleteAiConnection(saved.connectionId);
      expect(nativeConnectorHeaderStatus(connection, ai)?.tone).not.toBe("ok");
    } finally {
      activation.dispose();
      lifetime.abort();
      release();
      await fixture.close();
    }
  },
);
