/** @vitest-environment node */
import { rootCertificates } from "node:tls";
import { expect, it } from "vitest";
import { Configuration } from "./protocol.js";

const base = {
  hostname: "peer-tls-test",
  controlURL: "https://control.example.test",
  authKey: "",
  state: {},
  assets: {
    runtime: "https://app.example.test/runtime.js",
    wasm: "https://app.example.test/node.wasm.gz",
    nativeHTTP: "https://app.example.test/native-http.js",
  },
};
it("retains independent public peer trust without provider-native configuration", () => {
  const parsed = Configuration.parse({
    ...base,
    peerTLS: { trustMode: "public" },
  });
  expect(parsed.peerTLS).toEqual({ trustMode: "public" });
  expect(parsed.nativeHTTP).toBeUndefined();
  expect(Configuration.parse(base).peerTLS).toBeUndefined();
});
it("clones explicit peer operator trust through the existing server-CA schema", () => {
  const certificate = rootCertificates[0];
  if (!certificate)
    throw new Error("Node server-trust fixture is unavailable.");
  const peerTLS = { trustMode: "operator", operatorCAPEM: certificate };
  const parsed = Configuration.parse({ ...base, peerTLS });
  peerTLS.operatorCAPEM = "replacement after parsing";
  expect(parsed.peerTLS).toEqual({
    trustMode: "operator",
    operatorCAPEM: certificate,
  });
  expect(parsed.nativeHTTP).toBeUndefined();
});
it.each([
  { trustMode: "operator", operatorCAPEM: "" },
  { trustMode: "operator", operatorCAPEM: "not a CA certificate" },
  { trustMode: "public", operatorCAPEM: "operator roots cannot join public" },
  { trustMode: "insecure" },
])("rejects invalid or mixed peer trust %#", (peerTLS) => {
  expect(Configuration.safeParse({ ...base, peerTLS }).success).toBe(false);
});
