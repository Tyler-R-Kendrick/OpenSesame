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
