import { rootCertificates } from "node:tls";
import { afterEach, beforeEach, expect, it } from "vitest";
import {
  DEVICE_CONNECTOR_KEYS,
  readDeviceRows,
} from "../device-connector-records.js";
import { kvFlush, kvForgetAll, kvHydrate } from "../kv.js";
import {
  deferred,
  runtimeFixture,
  runtimePassword,
} from "../secret-backends/runtime.test-support.js";
import { vaultStore } from "../vault/store.js";
import { TailscaleNativeHTTPConfiguration } from "./browser-node-port.js";
import {
  browserNodeCredentialFingerprint,
  browserNodePublicFingerprint,
  openBrowserNodeState,
  readBrowserNodeState,
  savedBrowserNodeConfiguration,
  updateBrowserNodeNativeHTTP,
  writeBrowserNodeState,
} from "./browser-node-store.js";
let fixture: Awaited<ReturnType<typeof runtimeFixture>>;
const config = {
  hostname: "operator-browser",
  controlURL: "https://controlplane.tailscale.com",
};
beforeEach(async () => {
  fixture = await runtimeFixture();
});
afterEach(async () => {
  await fixture.close();
});
function check() {
  if (vaultStore.getSnapshot().status !== "unlocked") throw new Error("locked");
}
function nativeConfig() {
  return TailscaleNativeHTTPConfiguration.parse({
    version: 1,
    exitNodeID: "approved-exit",
    trustMode: "public",
    targets: [
      {
        origin: "https://api.example.com",
        prefixes: ["203.0.113.0/24", "2001:db8::/32"],
      },
    ],
  });
}
it("snapshots HTTPS grants before awaiting custody and reloads sealed public options while locked", async () => {
  const nativeHTTP = nativeConfig();
  const expected = structuredClone(nativeHTTP);
  const opening = openBrowserNodeState(
    { ...config, nativeHTTP },
    vaultStore.getSnapshot().tomb,
    check,
  );
  nativeHTTP.exitNodeID = "caller-mutated";
  nativeHTTP.targets[0]?.prefixes.push("0.0.0.0/0");
  const initial = await opening;
  expect(initial.record.nativeHTTP).toEqual(expected);
  expect(savedBrowserNodeConfiguration()).toEqual({
    ...config,
    nativeHTTP: expected,
  });
  await kvFlush();
  for (const value of fixture.files.values())
    expect(value).not.toContain("approved-exit");
  vaultStore.lock();
  kvForgetAll();
  await kvHydrate([...DEVICE_CONNECTOR_KEYS]);
  expect(savedBrowserNodeConfiguration()).toEqual({
    ...config,
    nativeHTTP: expected,
  });
  expect(() => readBrowserNodeState(initial.record)).toThrow();
  await vaultStore.unlock(runtimePassword);
  expect(
    (await openBrowserNodeState(config, initial.record.tomb, check)).record,
  ).toEqual(initial.record);
});
it("retargets only public authority, invalidates the original saved guard and preserves exact node credentials", async () => {
  const initial = await openBrowserNodeState(
    config,
    vaultStore.getSnapshot().tomb,
    check,
  );
  await writeBrowserNodeState(
    initial.record,
    {},
    { machine: "same-private-key" },
    check,
  );
  const credential = browserNodeCredentialFingerprint(initial.record);
  const before = browserNodePublicFingerprint(
    initial.record,
    initial.connectionId,
  );
  const nativeHTTP = nativeConfig();
  const changed = await updateBrowserNodeNativeHTTP(
    initial.record,
    nativeHTTP,
    check,
  );
  expect(changed.reference).toBe(initial.record.reference);
  expect(browserNodeCredentialFingerprint(changed)).toBe(credential);
  expect(readBrowserNodeState(changed)).toEqual({
    machine: "same-private-key",
  });
  expect(() =>
    browserNodePublicFingerprint(initial.record, initial.connectionId),
  ).toThrow("changed");
  expect(() => readBrowserNodeState(initial.record)).toThrow("changed");
  await expect(
    updateBrowserNodeNativeHTTP(initial.record, nativeHTTP, check),
  ).rejects.toThrow("changed");
  expect(browserNodePublicFingerprint(changed, initial.connectionId)).not.toBe(
    before,
  );
  await expect(
    openBrowserNodeState(
      { ...config, nativeHTTP: { ...nativeHTTP, exitNodeID: "other" } },
      changed.tomb,
      check,
    ),
  ).rejects.toThrow("Update");
  const unchanged = browserNodePublicFingerprint(changed, initial.connectionId);
  await updateBrowserNodeNativeHTTP(changed, nativeHTTP, check);
  expect(browserNodePublicFingerprint(changed, initial.connectionId)).toBe(
    unchanged,
  );
  const removed = await updateBrowserNodeNativeHTTP(changed, undefined, check);
  expect(removed).toEqual(initial.record);
  expect(browserNodeCredentialFingerprint(removed)).toBe(credential);
  expect(savedBrowserNodeConfiguration()).toEqual(config);
});
it("refuses a retarget withdrawn during an actual staged sealed ledger write without persisting it", async () => {
  const initial = await openBrowserNodeState(
    config,
    vaultStore.getSnapshot().tomb,
    check,
  );
  await kvFlush();
  const before = new Map(fixture.files);
  const entered = deferred<void>();
  const release = deferred<void>();
  let current = true;
  fixture.beforeAtomicWrite(async () => {
    entered.resolve();
    await release.promise;
  });
  const pending = updateBrowserNodeNativeHTTP(
    initial.record,
    nativeConfig(),
    () => {
      check();
      if (!current) throw new Error("owner withdrawn");
    },
  );
  const rejected = expect(pending).rejects.toThrow("owner withdrawn");
  try {
    await entered.promise;
    current = false;
  } finally {
    release.resolve();
  }
  await rejected;
  expect(readDeviceRows()[0]?.fields.tailscale_browser_node).toBe(
    JSON.stringify(initial.record),
  );
  expect(fixture.files).toEqual(before);
  expect(readBrowserNodeState(initial.record)).toEqual({});
});
it("validates version, exact origins, masked IPv4/IPv6 grants, disjoint trust and bounded PEM before any new record", async () => {
  const valid = nativeConfig();
  const target = valid.targets[0];
  if (!target) throw new Error("Missing target");
  for (const invalid of [
    { ...valid, version: 2 },
    { ...valid, exitNodeID: " exit " },
    { ...valid, exitNodeID: "é".repeat(129) },
    { ...valid, operatorCAPEM: "secret" },
    { ...valid, targets: [] },
    { ...valid, targets: Array(17).fill(target) },
    ...[
      "http://api.example.com",
      "https://user@api.example.com",
      "https://api.example.com/path",
      "https://api.example.com?x=1",
    ].map((origin) => ({ ...valid, targets: [{ ...target, origin }] })),
    ...[
      "203.0.113.1/24",
      "256.0.0.0/8",
      "2001:db8::1/32",
      "::ffff:c000:200/120",
      "::ffff:192.0.2.0/120",
      "2001:db8::192.0.2.1/120",
      "::/129",
      "::%eth0/0",
    ].map((prefix) => ({
      ...valid,
      targets: [{ ...target, prefixes: [prefix] }],
    })),
    { ...valid, targets: [target, target] },
    { ...valid, trustMode: "operator" },
  ])
    expect(TailscaleNativeHTTPConfiguration.safeParse(invalid).success).toBe(
      false,
    );
  expect(
    TailscaleNativeHTTPConfiguration.safeParse({
      ...valid,
      targets: [{ ...target, prefixes: ["2001:db8::192.0.2.0/120"] }],
    }).success,
  ).toBe(true);
  const pem = rootCertificates[0];
  if (!pem) throw new Error("Node has no public certificate fixture");
  const operator = { ...valid, trustMode: "operator", operatorCAPEM: pem };
  expect(TailscaleNativeHTTPConfiguration.parse(operator)).toEqual(operator);
  for (const invalid of [
    "bad",
    `${pem}private-key`,
    pem.repeat(9),
    "x".repeat(65537),
    pem.replace("CERTIFICATE", "PRIVATE KEY"),
    "-----BEGIN CERTIFICATE-----\nMAE=\n-----END CERTIFICATE-----",
  ])
    expect(
      TailscaleNativeHTTPConfiguration.safeParse({
        ...operator,
        operatorCAPEM: invalid,
      }).success,
    ).toBe(false);
  await expect(
    openBrowserNodeState(
      { ...config, nativeHTTP: { ...valid, exitNodeID: "" } },
      vaultStore.getSnapshot().tomb,
      check,
    ),
  ).rejects.toThrow();
  expect(readDeviceRows()).toEqual([]);
});
