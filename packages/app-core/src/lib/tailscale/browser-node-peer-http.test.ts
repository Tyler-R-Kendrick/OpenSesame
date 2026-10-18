import { rootCertificates } from "node:tls";
import { expect, it } from "vitest";
import {
  TailscaleHTTPRouteConfiguration,
  TailscalePeerHTTPConfiguration,
} from "./browser-node-peer-http.js";
import { TailscaleNativeHTTPConfiguration } from "./browser-node-port.js";

const peer = {
  version: 2,
  routeMode: "peer",
  peerID: "n-approved-peer",
  trustMode: "public",
  targets: [
    {
      origin: "https://byo.example.test",
      prefixes: ["100.64.0.1/32", "fd7a:115c:a1e0::1/128"],
    },
  ],
};
it("composes direct-peer targets from the existing strict origin/CIDR/trust configuration", () => {
  expect(TailscalePeerHTTPConfiguration.parse(peer)).toEqual(peer);
  expect(TailscaleHTTPRouteConfiguration.parse(peer)).toEqual(peer);
  expect(TailscaleNativeHTTPConfiguration.safeParse(peer).success).toBe(false);
});
it("retains exact V1 exit bytes and does not silently reinterpret an exit as a peer", () => {
  const exit = {
    version: 1,
    exitNodeID: "n-approved-exit",
    trustMode: "public",
    targets: [{ origin: "https://api.example.test", prefixes: ["0.0.0.0/0"] }],
  };
  expect(TailscaleNativeHTTPConfiguration.parse(exit)).toEqual(exit);
  expect(TailscaleHTTPRouteConfiguration.parse(exit)).toEqual(exit);
  expect(TailscalePeerHTTPConfiguration.safeParse(exit).success).toBe(false);
  for (const invalid of [
    { ...peer, version: 1 },
    { ...peer, routeMode: "exit" },
    { ...peer, exitNodeID: "n-approved-exit" },
    { ...exit, peerID: "n-approved-peer" },
  ])
    expect(TailscaleHTTPRouteConfiguration.safeParse(invalid).success).toBe(
      false,
    );
});
it("keeps operator roots explicit and disjoint from public trust", () => {
  const operatorCAPEM = rootCertificates[0];
  if (!operatorCAPEM) throw new Error("Missing actual CA fixture");
  const operator = { ...peer, trustMode: "operator", operatorCAPEM };
  expect(TailscalePeerHTTPConfiguration.parse(operator)).toEqual(operator);
  for (const invalid of [
    { ...peer, operatorCAPEM },
    { ...peer, trustMode: "operator" },
    { ...operator, operatorCAPEM: "not a CA certificate" },
    { ...peer, trustMode: "insecure" },
  ])
    expect(TailscalePeerHTTPConfiguration.safeParse(invalid).success).toBe(
      false,
    );
});
it("rejects non-tailnet, default, unmasked and mapped CIDRs", () => {
  for (const prefix of [
    "127.0.0.1/32",
    "169.254.0.0/16",
    "192.168.0.0/16",
    "203.0.113.0/24",
    "0.0.0.0/0",
    "100.63.0.0/16",
    "100.128.0.0/9",
    "100.64.0.1/24",
    "100.64.0.0/9",
    "::/0",
    "::1/128",
    "fd7a:115c:a1e0::/47",
    "fd7a:115c:a1e1::/48",
    "::ffff:100.64.0.1/128",
  ])
    expect(
      TailscalePeerHTTPConfiguration.safeParse({
        ...peer,
        targets: [{ ...peer.targets[0], prefixes: [prefix] }],
      }).success,
    ).toBe(false);
});
it("requires a bounded stable ID and refuses client-supplied readiness/key/address claims", () => {
  for (const peerID of ["", " peer", "peer ", "peer\n", "x".repeat(257)])
    expect(
      TailscalePeerHTTPConfiguration.safeParse({ ...peer, peerID }).success,
    ).toBe(false);
  for (const claims of [
    { online: true },
    { machineAuthorized: true },
    { nodeKey: "untrusted" },
    { addresses: ["100.64.0.1"] },
    { allowExitFallback: true },
    { allowSubnetRoutes: true },
  ])
    expect(
      TailscalePeerHTTPConfiguration.safeParse({ ...peer, ...claims }).success,
    ).toBe(false);
});
it("preserves exact TLS hostname/authority validation and duplicate-origin refusal", () => {
  for (const origin of [
    "http://byo.example.test",
    "https://user:secret@byo.example.test",
    "https://byo.example.test/",
    "https://byo.example.test/path",
    "https://byo.example.test?retarget=1",
    "https://byo.example.test#retarget",
  ])
    expect(
      TailscalePeerHTTPConfiguration.safeParse({
        ...peer,
        targets: [{ ...peer.targets[0], origin }],
      }).success,
    ).toBe(false);
  expect(
    TailscalePeerHTTPConfiguration.safeParse({
      ...peer,
      targets: [peer.targets[0], peer.targets[0]],
    }).success,
  ).toBe(false);
});
