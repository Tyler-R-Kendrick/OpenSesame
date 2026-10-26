/** Owned HTTPS protocol fixtures and real local vault/composition ports; no Worker or browser claim. */
import { File } from "node:buffer";
import { webcrypto } from "node:crypto";
import {
  FIXTURE_FACTS,
  buildConsentReceipt,
} from "@opensesame/capability-composition";
import { afterEach, beforeEach, expect, vi } from "vitest";
import { configureHost } from "../../host.js";
import { webLocksDouble } from "../../lib/__tests__/web-locks-double.js";
import { CAPABILITY_CATALOG } from "../../lib/capabilities/catalog.js";
import { assertLeaseCurrent } from "../../lib/capabilities/lease.js";
import { CompositionStore, storeSeams } from "../../lib/capabilities/store.js";
import { clearSession } from "../../lib/federation.js";
import { identityConnectionDraft } from "../../lib/identity-connections-presets.js";
import {
  getIdentityConnectionRuntime,
  writeIdentityConnection,
} from "../../lib/identity-connections-store.js";
import { captureNativeIdentityOwner } from "../../lib/identity-native-owner.js";
import { kvFlush, kvForgetAll, kvGet } from "../../lib/kv.js";
import {
  bindNativeProviderTransport,
  captureNativeProviderAuthority,
} from "../../lib/native-connector-transport.js";
import { restoreOriginPublicationFixture } from "../../lib/origin-file-publication-custody.test-support.js";
import { loadSettings, saveSettings } from "../../lib/settings.js";
import { vaultStore } from "../../lib/vault/store.js";
import { vfsFlush } from "../../lib/vfs.js";
import { createTestHost } from "../../test-host.js";
import {
  type NativeOidcAdmissionRuntime,
  createNativeOidcAdmissionRuntime,
} from "./admission.js";
import type { OidcOwner } from "./claims.js";
import { tlsOracle } from "./tls.test-support.js";
import { prepareConfiguredOidc } from "./transaction.js";

const cleanup: (() => void)[] = [];
const seams = { ...storeSeams };
export const callback =
  "https://pwa.example.test/OpenSesame/auth/native-connector.html";
beforeEach(async () => {
  await vaultStore.flushPendingWrites();
  await vfsFlush();
  await kvFlush();
  clearSession();
  await vaultStore.lock();
  kvForgetAll();
  vi.stubGlobal("crypto", webcrypto);
  vi.stubGlobal("File", File);
  configureHost(createTestHost());
  vaultStore.loadActiveProjectScope();
});
afterEach(async () => {
  for (const stop of cleanup.splice(0).reverse()) stop();
  clearSession();
  await vaultStore.flushPendingWrites();
  await vfsFlush();
  await kvFlush();
  await vaultStore.lock();
  await kvFlush();
  restoreOriginPublicationFixture();
  Object.assign(storeSeams, seams);
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  kvForgetAll();
});
export function runtime() {
  const selected = createNativeOidcAdmissionRuntime();
  cleanup.push(selected.dispose);
  return selected;
}
export function hold() {
  let resolve: () => void = () => undefined;
  let reject: (error: Error) => void = () => undefined;
  const promise = new Promise<void>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
export function material() {
  const header = vaultStore.getSnapshot().header;
  return JSON.stringify(
    header && {
      v: header.v,
      createdAt: header.createdAt,
      kdf: header.kdf,
      wrap: header.wrap,
      unlocks: header.unlocks,
    },
  );
}
export async function protocol(
  method = "client_secret_basic",
  original?: OidcOwner,
  existing?: Awaited<ReturnType<typeof tlsOracle>>,
) {
  const idp = existing ?? (await tlsOracle(method, "both"));
  const stop = new AbortController();
  let captures = 0;
  const port = {
    ...idp.transport,
    signal: original
      ? AbortSignal.any([stop.signal, idp.owner.signal, original.signal])
      : AbortSignal.any([stop.signal, idp.owner.signal]),
    assertCurrent() {
      stop.signal.throwIfAborted();
      idp.owner.assertCurrent();
      original?.assertCurrent();
    },
  };
  cleanup.push(
    bindNativeProviderTransport({
      ...port,
      capture() {
        captures++;
        port.assertCurrent();
        return port;
      },
    }),
  );
  const authority = captureNativeProviderAuthority();
  const transport = authority.capture();
  const complete = async () => {
    const attempt = await prepareConfiguredOidc(
      idp.config,
      callback,
      transport,
      idp.owner,
    );
    idp.authorize(attempt.authorizationUrl);
    return attempt.complete({
      state: attempt.state,
      code: "independent-once",
      error: false,
    });
  };
  return { idp, stop, transport, complete, captures: () => captures };
}
export async function networking() {
  storeSeams.locks = () => webLocksDouble();
  storeSeams.distribution = async () => ({
    distributionId: "owned-oidc-admission-lease",
    mode: "selective",
    capabilityIds: CAPABILITY_CATALOG.capabilities.map((c) => c.id),
    moduleIds: CAPABILITY_CATALOG.capabilities.flatMap((c) => c.moduleIds),
    workerVariants: [{ id: "core-only", scriptPath: "sw.js", satisfies: [] }],
    basePath: "/",
  });
  const store = new CompositionStore();
  await store.boot({
    runtimeConfig: {
      status: "absent",
      endpoints: {},
      ambientAuth: undefined,
      capabilityComposition: null,
      diagnostics: [],
    },
    vaultId: null,
    facts: { ...FIXTURE_FACTS, now: new Date().toISOString() },
  });
  const identity = store.getSnapshot().plan?.identity;
  if (!identity) throw new Error("Actual composition plan missing");
  const draft = {
    schemaVersion: 1 as const,
    kind: "InstallationCapabilitySelection" as const,
    instanceId: identity.instanceId,
    installationId: identity.installationId,
    basePolicyRevision: identity.policyRevision,
    revision: "owned-network-consent",
    acceptedRequired: [],
    selectedOptional: ["networking.tailnet"],
    chosenAlternatives: {},
    delivery: {
      prefetch: "none" as const,
      offlineCache: "shell-only" as const,
    },
  };
  const receipt = buildConsentReceipt(
    store.preview(draft),
    CAPABILITY_CATALOG,
    new Date().toISOString(),
  );
  expect((await store.commit(draft, receipt)).status).toBe("committed");
  const lease = store.currentLease();
  cleanup.push(
    () => store.resetForTest(),
    vaultStore.subscribe(() => {
      const now = vaultStore.getSnapshot();
      store.onVaultChange(
        now.status === "unlocked" && !now.guest ? now.tomb : null,
      );
    }),
  );
  return {
    lease,
    assertCurrent() {
      assertLeaseCurrent(
        lease,
        store.getSnapshot().generation,
        "networking.tailnet",
      );
    },
  };
}
export async function saveAdapter(idp: Awaited<ReturnType<typeof tlsOracle>>) {
  const draft = {
    ...identityConnectionDraft("byo-identity"),
    name: "Owned native OIDC",
    issuer: idp.config.issuer,
    clientId: idp.config.clientId,
    clientSecret: idp.config.clientSecret,
    organizationId: "org_actual",
    oidcClientType: "confidential" as const,
  };
  const connection = await writeIdentityConnection(draft);
  saveSettings({
    ...loadSettings(),
    signIn: {
      builtin: false,
      providers: [
        {
          providerId: draft.providerId,
          protocol: "oidc",
          nativeIdentity: true,
          connectionId: connection.connectionId,
          issuer: draft.issuer,
          clientId: draft.clientId,
          label: draft.name,
        },
      ],
    },
  });
  return { draft, connection };
}
export async function localCeremony(mode: "pin" | "password" = "pin") {
  if (mode === "pin") await vaultStore.createWithPin("82946731");
  else await vaultStore.create("ordinary local test password");
  await vaultStore.addFolder("Original OIDC protected folder");
  const idp = await tlsOracle("client_secret_basic", "both");
  const { draft, connection } = await saveAdapter(idp);
  await vaultStore.flushPendingWrites();
  await vaultStore.lock();
  // Capture the real locked-vault composition generation, not the earlier unlocked one.
  const lockedNetwork = await networking();
  const originalProtocol = await protocol(
    "client_secret_basic",
    {
      signal: lockedNetwork.lease.signal,
      assertCurrent: lockedNetwork.assertCurrent,
    },
    idp,
  );
  const saved = getIdentityConnectionRuntime(connection.connectionId);
  if (!saved) throw new Error("Actual sealed configuration missing");
  const owner = captureNativeIdentityOwner(connection.connectionId, "oidc");
  owner.bindConfiguration(saved);
  const activation: NativeOidcAdmissionRuntime[] = [];
  owner.prepareRuntime(() => {
    activation.push(runtime());
  });
  const current = activation[0];
  if (!current)
    throw new Error("Original runtime installation did not complete");
  cleanup.push(owner.release);
  const before = material();
  const body = kvGet("tomb/personal/body");
  if (!body) throw new Error("Original encrypted vault body missing");
  const attempt = await prepareConfiguredOidc(
    originalProtocol.idp.config,
    callback,
    originalProtocol.transport,
    { signal: owner.signal, assertCurrent: owner.assertPending },
  );
  originalProtocol.idp.authorize(attempt.authorizationUrl);
  const proof = await attempt.complete({
    state: attempt.state,
    code: "independent-once",
    error: false,
  });
  const retireWith = async (work: () => Promise<void>) => {
    owner.assertPending();
    originalProtocol.stop.abort();
    await work();
    owner.assertPending();
  };
  return {
    ...originalProtocol,
    network: lockedNetwork,
    owner,
    saved,
    connection,
    before,
    body,
    retireWith,
    proof,
    runtime: current,
    target: {
      connectionId: connection.connectionId,
      label: draft.name,
      assertSessionCurrent: (claims: { issuer: string; audience: string }) =>
        owner.assertSessionCurrent(claims.issuer, claims.audience),
      retireProtocol: () => retireWith(async () => undefined),
      releaseSession: owner.release,
    },
  };
}
