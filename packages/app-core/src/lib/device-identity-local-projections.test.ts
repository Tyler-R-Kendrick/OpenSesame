/** @vitest-environment jsdom */
/** Real vault/password, directory writes, application policy and VFS encryption.
 * Physical Web Locks and refused network ports are declared adapter doubles; no IAM/authentication mock.
 */
import { type BoundaryValue, isJsonObject } from "@opensesame/os-domain";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { configureHost, host } from "../host.js";
import { createTestHost } from "../test-host.js";
import { webLocksDouble } from "./__tests__/web-locks-double.js";
import {
  deviceIdentityFetch,
  resetDeviceIdentitySessionsForTests,
} from "./device-identity-host.js";
import { LOCAL_IAM_DEVICE_ROUTES } from "./device-identity-local.js";
import {
  registerDeviceRoutes,
  resetDeviceRoutesForTests,
} from "./device-identity-routes.js";
import { clearActivePresentation } from "./duress/compartment/presentation-runtime.js";
import { clearEnrollmentStateForUnlock } from "./duress/store/unlock-enrollment.js";
import { kvDelete, kvGet } from "./kv.js";
import {
  configureLocalApplication,
  readLocalApplications,
} from "./local-applications.js";
import { changeLocalDirectory } from "./local-directory-admin.js";
import { ensureOwnerPerson } from "./local-directory-bootstrap.js";
import {
  LOCAL_DIRECTORY_PATH,
  type LocalDirectoryChange,
  type LocalIdentityKind,
  readLocalDirectory,
} from "./local-directory.js";
import { enrollRetiredCredential } from "./retired-credentials/index.js";
import { flushRetiredCredentialTelemetry } from "./retired-credentials/telemetry-queue.js";
import { unlockWithRetiredCredentialGate } from "./retired-credentials/unlock.js";
import {
  PASSWORD,
  clearVaultSurface,
} from "./vault/protection/protector-enrollment.test-support.js";
import { vaultStore } from "./vault/store.js";
import { tombFileKey, writeFile } from "./vfs.js";

const originalHost = host();
const tomb = "personal";
const applicationsPath = "config/identity-applications";
const directoryKey = tombFileKey(tomb, LOCAL_DIRECTORY_PATH);
const applicationsKey = tombFileKey(tomb, applicationsPath);
const trapKey = tombFileKey(tomb, "retired-credentials.v1");
let organization: string;
let agent: string;
let application: string;
let disabledAgent: string;
let disabledOrganization: string;

async function change(command: LocalDirectoryChange) {
  return changeLocalDirectory(
    tomb,
    (await readLocalDirectory(tomb)).revision,
    command,
  );
}
async function create(kind: LocalIdentityKind, name: string) {
  const directory = await change({ action: "create", kind, name });
  const entry = directory.entries.find((row) => row.name === name);
  if (!entry) throw new Error("Missing actual created identity");
  return entry.id;
}
async function rows(path: string) {
  const response = await deviceIdentityFetch(path);
  expect(response.status).toBe(200);
  const body: BoundaryValue = await response.json();
  if (!isJsonObject(body))
    throw new Error("Expected actual directory response object");
  return body;
}

async function withheldProjections(status: 200 | 423) {
  const refusals: string[] = [];
  for (const path of ["/v1/organizations", "/v1/agents", "/v1/oauth/clients"]) {
    const response = await deviceIdentityFetch(path);
    expect(response.status).toBe(status);
    const text = await response.text();
    if (status === 200) {
      const key = path.endsWith("clients") ? "clients" : path.slice(4);
      expect(JSON.parse(text)).toEqual({ [key]: [] });
    }
    refusals.push(text);
  }
  const body = JSON.stringify(refusals);
  for (const privateValue of [organization, agent, application, "Private"])
    expect(body).not.toContain(privateValue);
}

beforeEach(async () => {
  vaultStore.lock();
  await flushRetiredCredentialTelemetry();
  configureHost(
    createTestHost({
      locks: webLocksDouble(),
      storage: { local: window.localStorage, session: window.sessionStorage },
    }),
  );
  await clearVaultSurface();
  clearEnrollmentStateForUnlock();
  for (const key of [directoryKey, applicationsKey, trapKey]) kvDelete(key);
  await vaultStore.create(PASSWORD);
  await ensureOwnerPerson(tomb, "Private owner");
  const person = (await readLocalDirectory(tomb)).entries.find(
    (row) => row.kind === "person",
  );
  if (!person) throw new Error("Missing actual owner");
  organization = await create("organization", "Private organization");
  await change({
    action: "membership",
    organizationId: organization,
    principalId: person.id,
    role: "owner",
  });
  disabledOrganization = await create("organization", "Disabled organization");
  await change({
    action: "membership",
    organizationId: disabledOrganization,
    principalId: person.id,
    role: "owner",
  });
  await change({
    action: "update",
    id: disabledOrganization,
    name: "Disabled organization",
    enabled: false,
  });
  agent = await create("agent", "Private agent");
  disabledAgent = await create("agent", "Disabled agent");
  await change({
    action: "update",
    id: disabledAgent,
    name: "Disabled agent",
    enabled: false,
  });
  application = await create("application", "Private application");
  await configureLocalApplication(
    tomb,
    (await readLocalApplications(tomb)).revision,
    application,
    {
      applicationId: application,
      organizationId: organization,
      redirectUris: ["https://private-rp.example.test/callback"],
      scopes: ["openid", "profile"],
    },
  );
  await vaultStore.flushPendingWrites();
  resetDeviceIdentitySessionsForTests();
  resetDeviceRoutesForTests();
  registerDeviceRoutes(LOCAL_IAM_DEVICE_ROUTES);
});
afterEach(async () => {
  vaultStore.lock();
  await flushRetiredCredentialTelemetry();
  clearActivePresentation();
  resetDeviceIdentitySessionsForTests();
  resetDeviceRoutesForTests();
  for (const key of [directoryKey, applicationsKey, trapKey]) kvDelete(key);
  vi.restoreAllMocks();
  configureHost(originalHost);
});

it("projects real encrypted memberships, enabled agents and registered OAuth clients without turning registration into a grant", async () => {
  const network = vi
    .spyOn(globalThis, "fetch")
    .mockRejectedValue(new Error("Unexpected network dispatch"));
  const encryptedDirectory = kvGet(directoryKey);
  const encryptedApplications = kvGet(applicationsKey);
  expect(encryptedDirectory).toBeTruthy();
  expect(encryptedApplications).toBeTruthy();
  expect(encryptedDirectory).not.toContain("Private organization");
  expect(encryptedApplications).not.toContain("private-rp.example.test");
  const organizations = await rows("/v1/organizations");
  expect(organizations.organizations).toContainEqual({
    id: organization,
    slug: organization,
    displayName: "Private organization",
    role: "owner",
    state: "active",
  });
  expect(organizations.organizations).not.toContainEqual(
    expect.objectContaining({ id: disabledOrganization }),
  );
  const agents = await rows("/v1/agents");
  expect(agents.agents).toContainEqual(
    expect.objectContaining({
      id: agent,
      displayName: "Private agent",
      state: "active",
    }),
  );
  expect(agents.agents).not.toContainEqual(
    expect.objectContaining({ id: disabledAgent }),
  );
  const clients = await rows("/v1/oauth/clients");
  expect(clients.clients).toContainEqual(
    expect.objectContaining({
      id: application,
      displayName: "Private organization",
      admissionMode: "local",
      sectorIdentifier: "https://private-rp.example.test",
      redirectUris: ["https://private-rp.example.test/callback"],
      allowedScopes: ["openid", "profile"],
      tokenEndpointAuthMethod: "none",
    }),
  );
  expect((await deviceIdentityFetch("/v1/authorization-requests")).status).toBe(
    401,
  );
  expect(kvGet(directoryKey)).toBe(encryptedDirectory);
  expect(kvGet(applicationsKey)).toBe(encryptedApplications);
  expect(network).not.toHaveBeenCalled();
});

it("unsupported directory mutations leave genuine encrypted registrations untouched", async () => {
  const network = vi
    .spyOn(globalThis, "fetch")
    .mockRejectedValue(new Error("Unexpected network dispatch"));
  const before = [kvGet(directoryKey), kvGet(applicationsKey)];
  for (const path of [
    "/v1/organizations",
    "/v1/agents/private",
    "/v1/oauth/clients",
    "/v1/projects/personal",
  ]) {
    const response = await deviceIdentityFetch(path, {
      method: "DELETE",
      body: "{}",
    });
    expect(response.status).toBe(501);
    expect(await response.json()).toMatchObject({ error: "device_identity" });
  }
  expect([kvGet(directoryKey), kvGet(applicationsKey)]).toEqual(before);
  expect(network).not.toHaveBeenCalled();
});

it("withholds owner directory projections while locked and in an actual retired-password synthetic realm, then restores only after fresh password authentication", async () => {
  const retired = "selected retired IAM password";
  await enrollRetiredCredential({
    tomb,
    currentPassword: PASSWORD,
    retiredPassword: retired,
    response: "synthetic_decoy",
    acknowledgePasswordVerifierRisk: true,
  });
  const before = [kvGet(directoryKey), kvGet(applicationsKey)];
  vaultStore.lock();
  await withheldProjections(423);
  await expect(
    unlockWithRetiredCredentialGate(vaultStore, retired),
  ).resolves.toBe("retired_credential_session");
  expect(vaultStore.getSnapshot()).toMatchObject({
    status: "unlocked",
    guest: true,
    decoy: true,
  });
  await withheldProjections(200);
  expect([kvGet(directoryKey), kvGet(applicationsKey)]).toEqual(before);
  vaultStore.lock();
  await vaultStore.unlock(PASSWORD);
  expect(vaultStore.getSnapshot()).toMatchObject({
    status: "unlocked",
    guest: false,
    decoy: false,
  });
  expect((await rows("/v1/oauth/clients")).clients).toContainEqual(
    expect.objectContaining({ id: application }),
  );
  expect([kvGet(directoryKey), kvGet(applicationsKey)]).toEqual(before);
});

it("malformed encrypted directory and application payloads are refused without rewriting their ciphertext", async () => {
  await writeFile(
    tomb,
    LOCAL_DIRECTORY_PATH,
    new TextEncoder().encode('{"version":2}'),
  );
  const malformedDirectory = kvGet(directoryKey);
  expect(await rows("/v1/organizations")).toEqual({ organizations: [] });
  expect(await rows("/v1/agents")).toEqual({ agents: [] });
  expect(kvGet(directoryKey)).toBe(malformedDirectory);
  await writeFile(
    tomb,
    applicationsPath,
    new TextEncoder().encode('{"version":2}'),
  );
  const malformedApplications = kvGet(applicationsKey);
  expect(await rows("/v1/oauth/clients")).toEqual({ clients: [] });
  expect(kvGet(applicationsKey)).toBe(malformedApplications);
});
