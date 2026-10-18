import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { readDeviceRows } from "../device-connector-records.js";
import { vaultStore } from "../vault/store.js";
import { secretBackendCredentialTarget } from "./credential-custody.js";
import { secretBackendDraft } from "./presets.js";
import {
  connectSecretBackend,
  probeSecretBackend,
  saveSecretBackendConnection,
  secretBackendRuntimeSeams,
} from "./runtime.js";
import {
  ledgerFile,
  remoteDraft,
  runtimeFixture,
} from "./runtime.test-support.js";
import { publicSecretBackendDraft } from "./schema.js";
import { createSecretBackendSessions } from "./sessions.js";
import {
  readSecretBackendConnection,
  resolveSecretBackendConfiguration,
  secretBackendRuntimeConfiguration,
} from "./store.js";
import {
  type SecretBackend,
  type SecretBackendConfiguration,
  SecretBackendError,
} from "./types.js";

let fixture: Awaited<ReturnType<typeof runtimeFixture>>;
beforeEach(async () => {
  fixture = await runtimeFixture();
});
afterEach(async () => {
  await fixture.close();
});
function nativeDraft() {
  return {
    ...secretBackendDraft("bitwarden"),
    name: "Owned native account",
    baseUrl: "https://api.owned.example",
    identityUrl: "https://identity.owned.example",
    clientId: "user.00000000-0000-4000-8000-000000000001",
    clientSecret: "synthetic-api-secret",
    accountEmail: "native@owned.example",
    deviceIdentifier: "00000000-0000-4000-8000-000000000002",
  };
}
it("stores a personal API secret in the real vault while stripping the transient master password from every persisted connection surface", async () => {
  const input = {
    ...nativeDraft(),
    masterPassword: "synthetic-transient-master-password",
  };
  const saved = await saveSecretBackendConnection(input);
  const publicDraft = readSecretBackendConnection(saved.connectionId);
  expect(publicDraft).toMatchObject({
    accountEmail: input.accountEmail,
    deviceIdentifier: input.deviceIdentifier,
    clientSecret: "",
  });
  expect(publicDraft).not.toHaveProperty("masterPassword");
  expect(
    secretBackendRuntimeConfiguration(
      saved.connectionId,
      vaultStore.getSnapshot().tomb,
    ),
  ).toMatchObject({ clientSecret: input.clientSecret });
  expect(publicSecretBackendDraft(input)).not.toHaveProperty("masterPassword");
  expect(JSON.stringify(readDeviceRows())).not.toContain(input.masterPassword);
  expect(fixture.files.get(ledgerFile)).not.toContain(input.masterPassword);
  const credentials = vaultStore
    .getSnapshot()
    .items.filter((item) => item.kind === "credential");
  expect(JSON.stringify(credentials)).toContain(input.clientSecret);
  expect(JSON.stringify(credentials)).not.toContain(input.masterPassword);
  expect(vaultStore.exportSealed()).not.toContain(input.clientSecret);
  expect(vaultStore.exportSealed()).not.toContain(input.masterPassword);
});
it("binds saved personal API credentials to the exact native account and device without changing existing other-provider target bindings", async () => {
  const input = nativeDraft();
  const saved = await saveSecretBackendConnection(input);
  const publicDraft = readSecretBackendConnection(saved.connectionId);
  if (!publicDraft) throw new Error("Missing real saved configuration.");
  const tomb = vaultStore.getSnapshot().tomb;
  expect(
    resolveSecretBackendConfiguration(
      { ...publicDraft, name: "Rename only" },
      saved.connectionId,
      tomb,
    ).clientSecret,
  ).toBe(input.clientSecret);
  for (const changed of [
    { accountEmail: "another@owned.example" },
    { deviceIdentifier: "00000000-0000-4000-8000-000000000003" },
  ]) {
    expect(() =>
      resolveSecretBackendConfiguration(
        { ...publicDraft, ...changed },
        saved.connectionId,
        tomb,
      ),
    ).toThrow();
    expect(secretBackendCredentialTarget({ ...input, ...changed })).not.toBe(
      secretBackendCredentialTarget(input),
    );
  }
  const other = remoteDraft();
  expect(secretBackendCredentialTarget(other)).toBe(
    JSON.stringify([
      "secret-backend",
      other.providerId,
      other.mode,
      other.baseUrl,
      other.identityUrl,
      other.vaultId,
      other.projectId,
      other.organizationId,
      other.environment,
      other.secretPath,
      other.clientId,
      other.passwordListId,
    ]),
  );
  expect(
    secretBackendCredentialTarget({
      ...other,
      accountEmail: "unused",
      deviceIdentifier: "unused",
    }),
  ).toBe(secretBackendCredentialTarget(other));
});
it("forwards one supplied unlock password through saved connect and probe but never recovers it from persistence (custody seam, not authentication proof)", async () => {
  const sessions = createSecretBackendSessions<object>("custody-seam");
  const observed: SecretBackendConfiguration[] = [];
  const backend: SecretBackend = {
    id: "custody-seam",
    name: "Configuration custody only",
    capabilities: {
      list: true,
      get: false,
      create: false,
      update: false,
      delete: false,
      import: false,
    },
    async authenticate(config) {
      observed.push(config);
      if (!config.masterPassword)
        throw new SecretBackendError(
          "configuration",
          "Supply a transient password.",
        );
      return sessions.create({});
    },
    async listItems(session) {
      sessions.read(session);
      return [];
    },
    async getItem() {
      throw new Error("No item operations in the custody seam.");
    },
    async getNotes() {
      throw new Error("No item operations in the custody seam.");
    },
    async disconnect(session) {
      sessions.remove(session);
    },
  };
  vi.spyOn(secretBackendRuntimeSeams, "createBackend").mockResolvedValue(
    backend,
  );
  const input = nativeDraft();
  const saved = await saveSecretBackendConnection(input);
  const publicDraft = readSecretBackendConnection(saved.connectionId);
  if (!publicDraft) throw new Error("Missing saved draft.");
  const password = "owned-one-attempt-password";
  const open = await connectSecretBackend(
    { ...publicDraft, masterPassword: password },
    saved.connectionId,
  );
  expect(observed[0]).toMatchObject({
    masterPassword: password,
    clientSecret: input.clientSecret,
    accountEmail: input.accountEmail,
  });
  await open.backend.disconnect(open.session);
  await probeSecretBackend(
    { ...publicDraft, masterPassword: "probe-only-password" },
    saved.connectionId,
  );
  expect(observed.at(-1)?.masterPassword).toBe("probe-only-password");
  await expect(connectSecretBackend(saved.connectionId)).rejects.toMatchObject({
    code: "configuration",
  });
  expect(observed.at(-1)?.masterPassword).toBeUndefined();
  expect(
    secretBackendRuntimeConfiguration(
      saved.connectionId,
      vaultStore.getSnapshot().tomb,
    ),
  ).not.toHaveProperty("masterPassword");
});
