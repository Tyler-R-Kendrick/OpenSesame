import { rootCertificates } from "node:tls";
import { afterEach, beforeEach, expect, it } from "vitest";
import {
  DEVICE_CONNECTOR_KEYS,
  readDeviceRows,
} from "../device-connector-records.js";
import { kvFlush, kvForgetAll, kvHydrate } from "../kv.js";
import {
  runtimeFixture,
  runtimePassword,
} from "../secret-backends/runtime.test-support.js";
import { vaultStore } from "../vault/store.js";
import { TailscalePeerHTTPConfiguration } from "./browser-node-peer-http.js";
import {
  TailscaleNativeHTTPConfiguration,
  TailscaleServerTrustConfiguration,
  normalizeTailscaleNodeIdentity,
} from "./browser-node-port.js";
import {
  browserNodeCredentialFingerprint,
  configureBrowserNodeState,
  openBrowserNodeState,
  readBrowserNodeState,
  savedBrowserNodeConfiguration,
  updateBrowserNodeNativeHTTP,
  writeBrowserNodeState,
} from "./browser-node-store.js";

let fixture: Awaited<ReturnType<typeof runtimeFixture>>;
beforeEach(async () => {
  fixture = await runtimeFixture();
});
afterEach(async () => {
  await fixture.close();
});
const identity = {
  hostname: "operator-browser",
  controlURL: "https://controlplane.tailscale.com",
};
function check() {
  if (vaultStore.getSnapshot().status !== "unlocked") throw new Error("locked");
}
function native() {
  return TailscaleNativeHTTPConfiguration.parse({
    version: 1,
    exitNodeID: "approved-exit",
    trustMode: "public",
    targets: [
      { origin: "https://api.example.com", prefixes: ["203.0.113.0/24"] },
    ],
  });
}

it("normalizes the common hostname/control identity before any configuration is persisted", () => {
  expect(
    normalizeTailscaleNodeIdentity({
      ...identity,
      controlURL: `${identity.controlURL}/`,
    }),
  ).toEqual(identity);
  expect(
    normalizeTailscaleNodeIdentity({
      ...identity,
      controlURL: "http://127.0.0.1:42316/",
    }).controlURL,
  ).toBe("http://127.0.0.1:42316");
  for (const hostname of ["", "UPPER", "-leading", "trailing-", "x".repeat(64)])
    expect(() =>
      normalizeTailscaleNodeIdentity({ ...identity, hostname }),
    ).toThrow();
  for (const controlURL of [
    "http://control.example",
    "https://user:secret@control.example/",
    "https://control.example/path",
    "https://control.example/?x=1",
    "https://control.example/#fragment",
  ])
    expect(() =>
      normalizeTailscaleNodeIdentity({ ...identity, controlURL }),
    ).toThrow();
});

it("saves explicit native options, reloads after vault lock and preserves the original encrypted node state", async () => {
  const tomb = vaultStore.getSnapshot().tomb;
  const route = native();
  const record = await configureBrowserNodeState(
    { ...identity, nativeHTTP: route },
    tomb,
    check,
  );
  await writeBrowserNodeState(
    record,
    {},
    { machine: "original-private-key" },
    check,
  );
  await vaultStore.flushPendingWrites();
  await kvFlush();
  vaultStore.lock();
  await kvFlush();
  kvForgetAll();
  await kvHydrate([...DEVICE_CONNECTOR_KEYS]);
  expect(savedBrowserNodeConfiguration()).toEqual({
    ...identity,
    nativeHTTP: route,
  });
  await vaultStore.unlock(runtimePassword);
  const reopened = await openBrowserNodeState(identity, tomb, check);
  expect(reopened.record.reference).toBe(record.reference);
  expect(readBrowserNodeState(reopened.record)).toEqual({
    machine: "original-private-key",
  });
});

it("retargets public/operator trust or explicitly disables native routing without replacing any private node credential", async () => {
  const tomb = vaultStore.getSnapshot().tomb;
  const initial = await configureBrowserNodeState(
    { ...identity, nativeHTTP: native() },
    tomb,
    check,
  );
  await writeBrowserNodeState(
    initial,
    {},
    { machine: "original-private-key" },
    check,
  );
  const receipt = browserNodeCredentialFingerprint(initial);
  const certificate = rootCertificates[0];
  if (!certificate) throw new Error("Missing real CA fixture");
  const operator = TailscaleNativeHTTPConfiguration.parse({
    ...native(),
    exitNodeID: "other-approved-exit",
    trustMode: "operator",
    operatorCAPEM: certificate,
  });
  const changed = await configureBrowserNodeState(
    { ...identity, nativeHTTP: operator },
    tomb,
    check,
  );
  expect(changed.reference).toBe(initial.reference);
  expect(browserNodeCredentialFingerprint(changed)).toBe(receipt);
  expect(savedBrowserNodeConfiguration()?.nativeHTTP).toEqual(operator);
  const disabled = await configureBrowserNodeState(identity, tomb, check);
  expect(disabled.nativeHTTP).toBeUndefined();
  expect(disabled.reference).toBe(initial.reference);
  expect(browserNodeCredentialFingerprint(disabled)).toBe(receipt);
  expect(readBrowserNodeState(disabled)).toEqual({
    machine: "original-private-key",
  });
});

it("rejects malformed routes and owner withdrawal before publishing configuration or private credentials", async () => {
  const before = readDeviceRows();
  const tomb = vaultStore.getSnapshot().tomb;
  await expect(
    configureBrowserNodeState(
      { ...identity, hostname: "INVALID" },
      tomb,
      check,
    ),
  ).rejects.toThrow();
  const malformed = {
    ...native(),
    targets: [
      { origin: "https://api.example.com", prefixes: ["203.0.113.1/24"] },
    ],
  };
  await expect(
    configureBrowserNodeState(
      { ...identity, nativeHTTP: malformed },
      tomb,
      check,
    ),
  ).rejects.toThrow();
  let calls = 0;
  await expect(
    configureBrowserNodeState(
      { ...identity, nativeHTTP: native() },
      tomb,
      () => {
        if (++calls === 2) vaultStore.lock();
        check();
      },
    ),
  ).rejects.toThrow();
  expect(readDeviceRows()).toEqual(before);
});

it("cold-reloads explicit peer authority and rejects the old peer record after retarget while retaining sealed node keys", async () => {
  const tomb = vaultStore.getSnapshot().tomb;
  const peer = TailscalePeerHTTPConfiguration.parse({
    version: 2,
    routeMode: "peer",
    peerID: "n-original-peer",
    trustMode: "public",
    targets: [
      { origin: "https://byo.example.test", prefixes: ["100.64.0.1/32"] },
    ],
  });
  const initial = await configureBrowserNodeState(
    { ...identity, nativeHTTP: peer },
    tomb,
    check,
  );
  await writeBrowserNodeState(
    initial,
    {},
    { machine: "original-private-peer-key" },
    check,
  );
  const credential = browserNodeCredentialFingerprint(initial);
  await vaultStore.flushPendingWrites();
  await kvFlush();
  vaultStore.lock();
  await kvFlush();
  kvForgetAll();
  await kvHydrate([...DEVICE_CONNECTOR_KEYS]);
  expect(savedBrowserNodeConfiguration()?.nativeHTTP).toEqual(peer);
  await vaultStore.unlock(runtimePassword);
  const reopened = await openBrowserNodeState(
    { ...identity, nativeHTTP: peer },
    tomb,
    check,
  );
  expect(reopened.record.reference).toBe(initial.reference);
  expect(browserNodeCredentialFingerprint(reopened.record)).toBe(credential);
  const replacement = { ...peer, peerID: "n-replacement-peer" };
  const changed = await configureBrowserNodeState(
    { ...identity, nativeHTTP: replacement },
    tomb,
    check,
  );
  expect(changed.reference).toBe(initial.reference);
  expect(browserNodeCredentialFingerprint(changed)).toBe(credential);
  expect(readBrowserNodeState(changed)).toEqual({
    machine: "original-private-peer-key",
  });
  expect(() => readBrowserNodeState(initial)).toThrow();
  await expect(
    openBrowserNodeState({ ...identity, nativeHTTP: peer }, tomb, check),
  ).rejects.toThrow("Update the saved native HTTPS");
  const disabled = await configureBrowserNodeState(identity, tomb, check);
  expect(disabled.nativeHTTP).toBeUndefined();
  expect(browserNodeCredentialFingerprint(disabled)).toBe(credential);
});
it("captures independent peer trust, restores it cold and retains keys across trust changes", async () => {
  const tomb = vaultStore.getSnapshot().tomb;
  const certificate = rootCertificates[0];
  if (!certificate) throw new Error("Missing real CA fixture");
  const peerTLS = {
    trustMode: "operator" as const,
    operatorCAPEM: certificate,
  };
  const opening = openBrowserNodeState({ ...identity, peerTLS }, tomb, check);
  peerTLS.operatorCAPEM = "caller changed the trust after capture";
  const initial = await opening;
  const expected = { trustMode: "operator", operatorCAPEM: certificate };
  expect(initial.record.peerTLS).toEqual(expected);
  expect(initial.record.nativeHTTP).toBeUndefined();
  await writeBrowserNodeState(
    initial.record,
    {},
    { machine: "original-peer-tls-key" },
    check,
  );
  const credential = browserNodeCredentialFingerprint(initial.record);
  await vaultStore.flushPendingWrites();
  await kvFlush();
  vaultStore.lock();
  await kvFlush();
  kvForgetAll();
  await kvHydrate([...DEVICE_CONNECTOR_KEYS]);
  expect(savedBrowserNodeConfiguration()?.peerTLS).toEqual(expected);
  await vaultStore.unlock(runtimePassword);
  const reopened = await openBrowserNodeState(identity, tomb, check);
  expect(reopened.record.reference).toBe(initial.record.reference);
  expect(browserNodeCredentialFingerprint(reopened.record)).toBe(credential);
  const routed = await updateBrowserNodeNativeHTTP(
    reopened.record,
    native(),
    check,
  );
  expect(routed.peerTLS).toEqual(expected);
  const cleared = await configureBrowserNodeState(identity, tomb, check);
  expect(cleared.peerTLS).toBeUndefined();
  expect(cleared.nativeHTTP).toBeUndefined();
  expect(cleared.reference).toBe(initial.record.reference);
  expect(browserNodeCredentialFingerprint(cleared)).toBe(credential);
  expect(readBrowserNodeState(cleared)).toEqual({
    machine: "original-peer-tls-key",
  });
  expect(() => readBrowserNodeState(routed)).toThrow();
});
it("uses the same strict public/operator CA schema for peer TLS", async () => {
  expect(
    TailscaleServerTrustConfiguration.parse({ trustMode: "public" }),
  ).toEqual({ trustMode: "public" });
  const before = readDeviceRows();
  for (const invalid of [
    { trustMode: "public", operatorCAPEM: rootCertificates[0] },
    { trustMode: "operator", operatorCAPEM: "not-a-certificate" },
    {
      trustMode: "operator",
      operatorCAPEM: rootCertificates[0],
      skipTLS: true,
    },
  ])
    expect(TailscaleServerTrustConfiguration.safeParse(invalid).success).toBe(
      false,
    );
  await expect(
    configureBrowserNodeState(
      { ...identity, peerTLS: { trustMode: "operator", operatorCAPEM: "bad" } },
      vaultStore.getSnapshot().tomb,
      check,
    ),
  ).rejects.toThrow();
  expect(readDeviceRows()).toEqual(before);
});
