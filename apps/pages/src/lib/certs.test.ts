import { beforeEach, describe, expect, it, vi } from "vitest";

const hostFetch = vi.hoisted(() =>
  vi.fn<(path: string, init?: RequestInit) => Promise<Response>>(),
);
import { identitySeams } from "./identity.js";
Object.assign(identitySeams, { hostFetch });
import { issueCertificate } from "./certs.js";

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
          purpose: "dev",
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    const issued = await issueCertificate({ commonName: "localhost" });
    expect(issued.commonName).toBe("localhost");
    expect(issued.privateKey).toContain("BEGIN PRIVATE KEY");
    const init = hostFetch.mock.calls[0]?.[1];
    if (!init) throw new Error("Host request was not recorded");
    expect(JSON.parse(String(init.body)).common_name).toBe("localhost");
  });
});
