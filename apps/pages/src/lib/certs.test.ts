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
            "-----BEGIN PRIVATE KEY-----\nMIGH\n-----END PRIVATE KEY-----", // gitleaks:allow -- synthetic fixture
          ca_certificate:
            "-----BEGIN CERTIFICATE-----\nCA\n-----END CERTIFICATE-----",
          serial: "aabb",
          common_name: "localhost",
          dns_names: ["localhost", 7, null],
          not_before: "2026-01-01",
          not_after: "2026-01-02",
          delivery_id: "certificate-request:one",
          purpose: "dev",
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    const issued = await issueCertificate({
      commonName: "localhost",
      dnsNames: ["localhost", "dev.localhost"],
      ipAddrs: ["127.0.0.1"],
      ttlHours: 12,
      idempotencyKey: "attempt-one",
    });
    expect(issued).toEqual({
      certificate:
        "-----BEGIN CERTIFICATE-----\nMII\n-----END CERTIFICATE-----",
      privateKey:
        "-----BEGIN PRIVATE KEY-----\nMIGH\n-----END PRIVATE KEY-----", // gitleaks:allow -- synthetic fixture
      caCertificate:
        "-----BEGIN CERTIFICATE-----\nCA\n-----END CERTIFICATE-----",
      serial: "aabb",
      commonName: "localhost",
      dnsNames: ["localhost"],
      notBefore: "2026-01-01",
      notAfter: "2026-01-02",
      deliveryId: "certificate-request:one",
    });
    expect(hostFetch.mock.calls[0]?.[0]).toBe("/api/v1/certs/issue");
    const init = hostFetch.mock.calls[0]?.[1];
    if (!init) throw new Error("Host request was not recorded");
    expect(init.method).toBe("POST");
    const headers = new Headers(init.headers);
    expect(headers.get("content-type")).toBe("application/json");
    expect(headers.get("idempotency-key")).toBe("attempt-one");
    expect(JSON.parse(String(init.body))).toEqual({
      common_name: "localhost",
      dns_names: ["localhost", "dev.localhost"],
      ip_addrs: ["127.0.0.1"],
      ttl_hours: 12,
    });
  });

  it("uses bounded request defaults and optional response defaults", async () => {
    hostFetch.mockResolvedValue(
      Response.json({
        certificate: "cert",
        private_key: "key",
        common_name: "localhost",
        not_after: "later",
      }),
    );
    await expect(
      issueCertificate({ commonName: "localhost" }),
    ).resolves.toEqual({
      certificate: "cert",
      privateKey: "key",
      caCertificate: "",
      serial: "",
      commonName: "localhost",
      dnsNames: [],
      notBefore: "",
      notAfter: "later",
    });
    expect(JSON.parse(String(hostFetch.mock.calls[0]?.[1]?.body))).toEqual({
      common_name: "localhost",
      dns_names: [],
      ip_addrs: [],
      ttl_hours: 24,
    });
    expect(
      new Headers(hostFetch.mock.calls[0]?.[1]?.headers).has("idempotency-key"),
    ).toBe(false);
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

  it.each([
    [{ hint: "issuer refused" }, "issuer refused"],
    [{ error: "rate_limited" }, "rate_limited"],
  ])("reports safe Host refusal details", async (body, expected) => {
    hostFetch.mockResolvedValue(
      new Response(JSON.stringify(body), {
        status: 503,
        headers: { "content-type": "application/json" },
      }),
    );
    await expect(issueCertificate({ commonName: "localhost" })).rejects.toThrow(
      expected,
    );
  });

  it("falls back safely when a Host refusal is not JSON", async () => {
    hostFetch.mockResolvedValue(new Response("not-json", { status: 503 }));
    await expect(issueCertificate({ commonName: "localhost" })).rejects.toThrow(
      "Could not issue certificate (503)",
    );
  });

  it("rejects a non-object success response", async () => {
    hostFetch.mockResolvedValue(Response.json([]));
    await expect(issueCertificate({ commonName: "localhost" })).rejects.toThrow(
      "Host returned incomplete certificate material",
    );
  });

  it("reports delivery acknowledgement refusal", async () => {
    hostFetch.mockResolvedValue(
      Response.json({ error: "delivery_expired" }, { status: 410 }),
    );
    await expect(acknowledgeCertificateDelivery("gone")).rejects.toThrow(
      "delivery_expired",
    );
  });

  it("falls back safely when acknowledgement refusal is not JSON", async () => {
    hostFetch.mockResolvedValue(new Response("nope", { status: 502 }));
    await expect(acknowledgeCertificateDelivery("gone")).rejects.toThrow(
      "Could not acknowledge certificate delivery (502)",
    );
  });
});
