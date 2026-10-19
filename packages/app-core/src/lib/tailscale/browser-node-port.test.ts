import { rootCertificates } from "node:tls";
import { expect, it } from "vitest";
import { TailscaleNativeHTTPConfiguration } from "./browser-node-port.js";

function accepts(body: string): boolean {
  return TailscaleNativeHTTPConfiguration.safeParse({
    version: 1,
    exitNodeID: "approved-exit",
    trustMode: "operator",
    targets: [
      { origin: "https://api.example.test", prefixes: ["203.0.113.0/24"] },
    ],
    operatorCAPEM: `-----BEGIN CERTIFICATE-----\n${body}\n-----END CERTIFICATE-----`,
  }).success;
}

it("preserves canonical padded Base64 and complete DER syntax for public operator CA configuration", () => {
  // These small DER sequences test only the saved syntax guard. The captured
  // Go constructor still validates actual certificates and their key usages.
  for (const body of ["MAA=", "MAEA", "MAIAAA=="])
    expect(accepts(body), body).toBe(true);
  for (const body of [
    "MAA", // missing required padding
    "MAB=", // nonzero unused padding bits
    "MAIAAB==", // the same DER bytes with noncanonical padding bits
    "MAIAAA", // missing double padding
    "MA=AAA==", // interior padding
    "MAIAAA===", // excess padding
    "MAIA_A==", // URL alphabet is not PEM Base64
    "MAI AAA==", // spaces inside the body
    "MAE=", // truncated DER
    "MQA=", // not a sequence
    "MIEBAA==", // nonminimal long-form DER length
    "MAAAAA==", // trailing bytes beyond the complete DER sequence
  ])
    expect(accepts(body), body).toBe(false);
  const certificate = rootCertificates[0];
  if (!certificate) throw new Error("Node has no public certificate fixture");
  const body = certificate.replace(/-----[^\n]+-----/g, "").replace(/\s/g, "");
  expect(accepts(body)).toBe(true);
  expect(accepts(body.replace(/(.{64})/g, "$1\r\n"))).toBe(true);
});
