import { describe, expect, it } from "vitest";
import { ProviderVerificationSchema } from "./connect-provider-auth-schema.js";
import type { NativeApiTarget } from "./native-api-target.js";
import { providerTemplate, providerUrl } from "./native-api-target.js";

type TargetParameters = {
  endpoint?: string;
  tenant?: string;
  first?: string;
  second?: string;
};

function target(
  parameters: TargetParameters,
  publicParameters: readonly string[] = Object.keys(parameters),
): NativeApiTarget {
  return {
    providerId: "obsidian",
    providerName: "Obsidian",
    profile: {
      auth: null,
      verify: ProviderVerificationSchema.parse({
        method: "GET",
        url: "https://{endpoint}/",
        accountField: null,
      }),
      templateParams: [],
      additionalCredentials: [],
    },
    parameters,
    classification: {
      publicParameters: [...publicParameters],
      privateCredentials: ["api_key"],
    },
  };
}

describe("providerUrl", () => {
  it("admits a loopback endpoint on its own port", () => {
    const url = providerUrl(
      "https://{endpoint}/",
      target({ endpoint: "127.0.0.1:27124" }),
      {},
    );
    expect(url.href).toBe("https://127.0.0.1:27124/");
    expect(
      providerUrl(
        "https://{endpoint}/",
        target({ endpoint: "localhost:8200" }),
        {},
      ).port,
    ).toBe("8200");
  });

  it("still requires the standard port for a public provider host", () => {
    // Even the standard port is hostname syntax a hostname-only contract refuses.
    expect(() =>
      providerUrl(
        "https://{endpoint}/",
        target({ endpoint: "api.example.com:443" }),
        {},
      ),
    ).toThrow("tenant host");
    expect(() =>
      providerUrl(
        "https://{endpoint}/",
        target({ endpoint: "127.attacker.example:8443" }),
        {},
      ),
    ).toThrow("tenant host");
    expect(() =>
      providerUrl(
        "https://{endpoint}/v1",
        target({ endpoint: "api.example.com:8443" }),
        {},
      ),
    ).toThrow("tenant host");
    // A template URL without a placeholder still answers to the compiled rule.
    expect(() =>
      providerUrl("https://api.example.com:8443/v1", target({}), {}),
    ).toThrow("compiled HTTPS target");
    expect(providerUrl("https://api.example.com/v1", target({}), {}).port).toBe(
      "",
    );
  });

  it("refuses a host parameter that is not a public field or carries garbage", () => {
    expect(() =>
      providerUrl(
        "https://{endpoint}/",
        target({ endpoint: "127.0.0.1:27124" }, []),
        {},
      ),
    ).toThrow("tenant host");
    expect(() =>
      providerUrl(
        "https://{endpoint}/",
        target({ endpoint: "127.0.0.1:blueberry" }),
        {},
      ),
    ).toThrow("tenant host");
    expect(() =>
      providerUrl(
        "https://{endpoint}/",
        target({ endpoint: ".127.0.0.1" }),
        {},
      ),
    ).toThrow("tenant host");
  });

  it("refuses path substitutions that normalize away a segment", () => {
    for (const tenant of [".", ".."]) {
      expect(() =>
        providerUrl(
          "https://api.example.com/v1/{tenant}/status",
          target({ tenant }),
          {},
        ),
      ).toThrow("valid provider parameters");
    }
  });

  it("checks assembled path segments without restricting query values", () => {
    expect(() =>
      providerUrl(
        "https://api.example.com/v1/{first}{second}/status",
        target({ first: ".", second: "." }),
        {},
      ),
    ).toThrow("valid provider parameters");
    expect(() =>
      providerTemplate("/v1/{tenant}/status", { tenant: ".." }, {}, true),
    ).toThrow("valid provider parameters");
    for (const tenant of [".", ".."]) {
      expect(
        providerUrl(
          "https://api.example.com/v1/status?q={tenant}",
          target({ tenant }),
          {},
        ).searchParams.get("q"),
      ).toBe(tenant);
      expect(
        providerUrl(
          "https://api.example.com/v1/prefix{tenant}/status",
          target({ tenant }),
          {},
        ).pathname,
      ).toBe(`/v1/prefix${tenant}/status`);
    }
  });

  it("fills host placeholders unencoded and path placeholders encoded", () => {
    const url = providerUrl(
      "https://{endpoint}/v1/{tenant}",
      target({ endpoint: "127.0.0.1:27124", tenant: "my org" }),
      {},
    );
    expect(url.href).toBe("https://127.0.0.1:27124/v1/my%20org");
  });
});
