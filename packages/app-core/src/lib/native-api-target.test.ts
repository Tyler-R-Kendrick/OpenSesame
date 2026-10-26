import { describe, expect, it } from "vitest";
import type { ProviderVerification } from "./connect-provider-auth-schema.js";
import type { NativeApiTarget } from "./native-api-target.js";
import { providerUrl } from "./native-api-target.js";

function target(
  parameters: Record<string, string>,
  publicParameters: readonly string[] = Object.keys(parameters),
): NativeApiTarget {
  return {
    providerId: "obsidian",
    providerName: "Obsidian",
    profile: {
      auth: null,
      verify: null as unknown as ProviderVerification,
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
    expect(() =>
      providerUrl(
        "https://{endpoint}/",
        target({ endpoint: "127.attacker.example:8443" }),
        {},
      ),
    ).toThrow("compiled HTTPS target");
    expect(() =>
      providerUrl(
        "https://{endpoint}/v1",
        target({ endpoint: "api.example.com:8443" }),
        {},
      ),
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

  it("fills host placeholders unencoded and path placeholders encoded", () => {
    const url = providerUrl(
      "https://{endpoint}/v1/{tenant}",
      target({ endpoint: "127.0.0.1:27124", tenant: "my org" }),
      {},
    );
    expect(url.href).toBe("https://127.0.0.1:27124/v1/my%20org");
  });
});
