import { rootCertificates } from "node:tls";
import { expect, it } from "vitest";
import type { NativeFieldValues } from "../connect/native-connector-ui.js";
import {
  nativeHTTPConfiguration,
  nativeHTTPDraft,
  nextNativeHTTPDraft,
} from "./tailscale-native-http-values.js";
it("round-trips each actual native trust configuration through shared field values", () => {
  const base = {
    version: 1 as const,
    exitNodeID: "n-approved",
    targets: [
      {
        origin: "https://api.example.com",
        prefixes: ["203.0.113.0/24", "2001:db8::/32"],
      },
      {
        origin: "https://other.example.com:8443",
        prefixes: ["198.51.100.4/32"],
      },
    ],
  };
  for (const config of [
    { ...base, trustMode: "public" as const },
    {
      ...base,
      trustMode: "operator" as const,
      operatorCAPEM: rootCertificates[0] ?? "",
    },
  ]) {
    expect(nativeHTTPConfiguration(nativeHTTPDraft(config))).toEqual(config);
  }
});
it("clears hidden CA material and disabled native routes through shared field transitions", () => {
  const draft = {
    ...nativeHTTPDraft(),
    mode: "native",
    exitNodeID: "n-approved",
    targets: "https://api.example.com 203.0.113.0/24",
    trustMode: "operator",
    operatorCAPEM: rootCertificates[0] ?? "",
  };
  const publicDraft = nextNativeHTTPDraft(draft, "trustMode", "public");
  expect(publicDraft).not.toHaveProperty("operatorCAPEM");
  expect(nativeHTTPConfiguration(publicDraft)).not.toHaveProperty(
    "operatorCAPEM",
  );
  const disabled = nextNativeHTTPDraft(draft, "mode", "browser");
  expect(disabled).toEqual(nativeHTTPDraft());
  expect(nativeHTTPConfiguration(disabled)).toBeUndefined();
});
it("refuses malformed or widening route input before it can be saved", () => {
  const draft = {
    ...nativeHTTPDraft(),
    mode: "native",
    exitNodeID: "n-approved",
    targets: "https://api.example.com 203.0.113.0/24",
  };
  const invalid: NativeFieldValues[] = [
    { mode: "invalid" },
    { exitNodeID: "" },
    { targets: "https://api.example.com" },
    { targets: "https://api.example.com/path 203.0.113.0/24" },
    { targets: "https://api.example.com 203.0.113.1/24" },
    { trustMode: "operator", operatorCAPEM: "not-a-certificate" },
  ];
  for (const change of invalid) {
    expect(() => nativeHTTPConfiguration({ ...draft, ...change })).toThrow();
  }
});

it("round-trips explicit peer routes and clears a hidden peer or exit identity on route changes", () => {
  const peer = {
    version: 2 as const,
    routeMode: "peer" as const,
    peerID: "n-original-peer",
    trustMode: "public" as const,
    targets: [
      { origin: "https://byo.example.test", prefixes: ["100.64.0.1/32"] },
    ],
  };
  expect(nativeHTTPConfiguration(nativeHTTPDraft(peer))).toEqual(peer);
  const operator = {
    ...peer,
    trustMode: "operator" as const,
    operatorCAPEM: rootCertificates[0] ?? "",
  };
  expect(nativeHTTPConfiguration(nativeHTTPDraft(operator))).toEqual(operator);
  const exitDraft = nextNativeHTTPDraft(
    nativeHTTPDraft(peer),
    "routeMode",
    "exit",
  );
  expect(exitDraft).not.toHaveProperty("peerID");
  const peerDraft = nextNativeHTTPDraft(
    { ...exitDraft, exitNodeID: "n-old-exit" },
    "routeMode",
    "peer",
  );
  expect(peerDraft).not.toHaveProperty("exitNodeID");
  expect(peerDraft.peerID).toBe("");
  expect(() => nativeHTTPConfiguration(peerDraft)).toThrow();
  expect(() =>
    nativeHTTPConfiguration({
      ...nativeHTTPDraft(peer),
      routeMode: "fallback",
    }),
  ).toThrow();
  expect(() =>
    nativeHTTPConfiguration({
      ...nativeHTTPDraft(peer),
      targets: "https://byo.example.test 0.0.0.0/0",
    }),
  ).toThrow();
});
