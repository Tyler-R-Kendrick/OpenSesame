import { beforeEach, describe, expect, it, vi } from "vitest";

const hostFetch = vi.hoisted(() =>
  vi.fn<(path: string, init?: RequestInit) => Promise<Response>>(),
);
import { identitySeams } from "./identity.js";
Object.assign(identitySeams, { hostFetch });
import { acknowledgeCertificateDelivery, issueCertificate } from "./certs.js";

describe("issueCertificate", () => {
  beforeEach(() => hostFetch.mockReset());

  it("maps Host issue response into vault-ready fields", async () => {
    hostFetch.mockResolvedValue(
      new Response(
        JSON.stringify({
          certificate:
            "-----BEGIN CERTIFICATE-----\nMII\n-----END CERTIFICATE-----",
          private_key:
            "-----BEGIN PRIVATE KEY-----\nMIGH\n-----END PRIVATE KEY-----",
          ca_certificate:
            "-----BEGIN CERTIFICATE-----\nCA\n-----END CERTIFICATE-----",
          serial: "aabb",
          common_name: "localhost",
          dns_names: ["localhost"],
          not_before: "2026-01-01",
          not_after: "2026-01-02",
          delivery_id: "certificate-request:one",
          purpose: "dev",
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    const issued = await issueCertificate({ commonName: "localhost" });
    expect(issued.commonName).toBe("localhost");
    expect(issued.privateKey).toContain("BEGIN PRIVATE KEY");
    expect(issued.deliveryId).toBe("certificate-request:one");
    const init = hostFetch.mock.calls[0]?.[1];
    if (!init) throw new Error("Host request was not recorded");
    expect(JSON.parse(String(init.body)).common_name).toBe("localhost");
  });

  it("contract: acknowledges one-time material only after holder storage", async () => {
    hostFetch.mockResolvedValue(new Response(null, { status: 204 }));
    await acknowledgeCertificateDelivery("certificate-request:one");
    expect(hostFetch).toHaveBeenCalledWith(
      "/api/v1/certs/deliveries/certificate-request%3Aone/ack",
      { method: "POST" },
    );
  });

  it("adversarial: rejects a successful response without one-time key material", async () => {
    hostFetch.mockResolvedValue(
      new Response(
        JSON.stringify({
          certificate:
            "-----BEGIN CERTIFICATE-----\nMII\n-----END CERTIFICATE-----",
          private_key: "",
          ca_certificate:
            "-----BEGIN CERTIFICATE-----\nCA\n-----END CERTIFICATE-----",
          common_name: "localhost",
          not_after: "2026-01-02",
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );

    await expect(issueCertificate({ commonName: "localhost" })).rejects.toThrow(
      "Host returned incomplete certificate material",
    );
  });
});
