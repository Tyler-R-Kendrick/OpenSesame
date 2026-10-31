import { describe, expect, it } from "vitest";
import type { NativeApiTarget } from "./native-api-target.js";
import { nativeApiFingerprint, providerUrl } from "./native-api-target.js";

function target(
  parameters: NativeApiTarget["parameters"],
  publicParameters: readonly string[] = Object.keys(parameters),
): NativeApiTarget {
  return {
    providerId: "obsidian",
    providerName: "Obsidian",
    profile: {
      auth: null,
      verify: {
        method: "GET",
        url: "https://example.test/",
        headers: {},
        body: null,
        accountField: null,
        auth: null,
        success: [],
        requiredFields: [],
        errorFields: [],
        validStatuses: [],
      },
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

  it("fills host placeholders unencoded and path placeholders encoded", () => {
    const url = providerUrl(
      "https://{endpoint}/v1/{tenant}",
      target({ endpoint: "127.0.0.1:27124", tenant: "my org" }),
      {},
    );
    expect(url.href).toBe("https://127.0.0.1:27124/v1/my%20org");
  });
});

describe("retained verification fingerprints", () => {
  it("preserves the historical fingerprint without a verification request", async () => {
    const input = target({});
    input.profile.verify = null;
    await expect(nativeApiFingerprint(input)).resolves.toBe(
      "13b320663235212895facb3e43af4776a9aa6f4d689199b63de4a6cb50575d88",
    );
  });
  it("preserves the historical ordinary verification fingerprint", async () => {
    await expect(nativeApiFingerprint(target({}))).resolves.toBe(
      "9076c131fdd6335be98fe504e44c6e40044d17ebd5502e0080bca451c0750205",
    );
  });
  it("binds each documented status proof to a distinct fingerprint", async () => {
    const input = target({});
    const verify = input.profile.verify;
    if (!verify) throw new Error("Expected ordinary verification");
    const ordinary = await nativeApiFingerprint(input);
    verify.validStatuses = [404];
    const missing = await nativeApiFingerprint(input);
    verify.validStatuses = [409];
    expect(await nativeApiFingerprint(input)).not.toBe(missing);
    expect(missing).not.toBe(ordinary);
  });
});
