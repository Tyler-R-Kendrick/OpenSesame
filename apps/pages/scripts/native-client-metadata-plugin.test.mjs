import { describe, expect, it, vi } from "vitest";
import {
  nativeClientMetadata,
  nativeClientMetadataPlugin,
} from "./native-client-metadata-plugin.mjs";

describe("public native connector OAuth client metadata", () => {
  it("emits public metadata only when the owned authorization entry is distributed", () => {
    const plugin = nativeClientMetadataPlugin("/vault/", {
      PAGES_CANONICAL_ORIGIN: "https://connections.example.test",
    });
    const emitFile = vi.fn();
    plugin.generateBundle.handler.call({ emitFile }, {}, { "index.html": {} });
    expect(emitFile).not.toHaveBeenCalled();
    plugin.generateBundle.handler.call(
      { emitFile },
      {},
      { "auth/native-connector.html": {} },
    );
    expect(emitFile).toHaveBeenCalledWith(
      expect.objectContaining({ fileName: "auth/native-client.json" }),
    );
    expect(JSON.parse(emitFile.mock.calls[0][0].source).client_id).toBe(
      "https://connections.example.test/vault/auth/native-client.json",
    );
  });
  it("binds a self-hosted public client and redirect to the deployment origin and base", () => {
    const document = nativeClientMetadata("/vault/", {
      PAGES_CANONICAL_ORIGIN: "https://connections.example.test",
    });
    expect(document.client_id).toBe(
      "https://connections.example.test/vault/auth/native-client.json",
    );
    expect(document.redirect_uris).toEqual([
      "https://connections.example.test/vault/auth/native-connector.html",
    ]);
    expect(document.token_endpoint_auth_method).toBe("none");
    expect(document).not.toHaveProperty("client_secret");
  });

  it("does not advertise an HTTP local development origin as a public client", () => {
    expect(
      nativeClientMetadata("/", {
        PAGES_CANONICAL_ORIGIN: "http://localhost:5180",
        PAGES_DEPLOYMENT_PROFILE: "loopback_development",
      }),
    ).toBeNull();
  });

  it("refuses a base on a different origin or with callback-contaminating parameters", () => {
    expect(() =>
      nativeClientMetadata("https://attacker.example/", {}),
    ).toThrow();
    expect(() => nativeClientMetadata("/vault/?redirect=evil", {})).toThrow();
  });
});
