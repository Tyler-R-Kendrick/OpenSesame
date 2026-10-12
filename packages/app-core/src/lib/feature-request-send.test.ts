import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installDoublePorts } from "./configuration/doubles/test-support.js";
import {
  createDeviceConnection,
  forgetDeviceConnectors,
} from "./device-connectors.js";
import {
  featureRequestSeams,
  performSavedCategory,
  performSavedConnector,
  registerCategorySend,
  resetCategorySendsForTest,
  sendFeatureOperation,
} from "./feature-request-send.js";

installDoublePorts();

const originals = { ...featureRequestSeams };
const fetchSpy = vi.fn<typeof featureRequestSeams.fetch>();
const performedSpy = vi.fn<typeof featureRequestSeams.performed>();

beforeEach(() => {
  forgetDeviceConnectors();
  resetCategorySendsForTest();
  fetchSpy.mockReset();
  performedSpy.mockReset();
  vi.stubGlobal("fetch", fetchSpy);
  featureRequestSeams.fetch = fetchSpy;
  featureRequestSeams.performed = performedSpy;
});

afterEach(() => {
  vi.unstubAllGlobals();
  Object.assign(featureRequestSeams, originals);
  resetCategorySendsForTest();
  forgetDeviceConnectors();
});

describe("unsupported connector dispatch", () => {
  it.each([
    ["anthropic", "model.list"],
    ["tailscale", "device.list"],
    ["passwordstate", "secret.configure"],
    ["stripe", "wallet.configure"],
    ["unknown-provider", "configure"],
  ])(
    "refuses %s without exposing credentials or claiming execution",
    (providerId, operation) => {
      const secret = "private-provider-credential";
      const result = sendFeatureOperation({
        ok: true,
        providerId,
        operation,
        action: { base_url: "https://untrusted.example.test", api_key: secret },
        secrets: { credential: secret, client_secret: secret },
      });
      expect(result).toEqual({ ok: false, providerId });
      expect(JSON.stringify(result)).not.toContain(secret);
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(performedSpy).not.toHaveBeenCalled();
    },
  );

  it("does not even resolve credentials for an unimplemented operation", () => {
    const result = sendFeatureOperation({
      ok: true,
      providerId: "vault",
      operation: "secret.configure",
      get action(): Record<string, string> {
        throw new Error("Configuration must stay unread");
      },
      get secrets(): Record<string, string> {
        throw new Error("Credentials must stay sealed");
      },
    });
    expect(result).toEqual({ ok: false, providerId: "vault" });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(performedSpy).not.toHaveBeenCalled();
  });

  it("refuses both saved and missing descriptors", () => {
    createDeviceConnection({ providerId: "passwordstate" });
    expect(performSavedConnector("passwordstate")).toEqual({
      ok: false,
      providerId: "passwordstate",
    });
    expect(performSavedConnector("unknown-provider")).toEqual({
      ok: false,
      providerId: "unknown-provider",
    });
    expect(sendFeatureOperation({ ok: false, providerId: "vault" })).toEqual({
      ok: false,
      providerId: "vault",
    });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(performedSpy).not.toHaveBeenCalled();
  });

  it("returns explicit refusal for saved providers without a category driver", () => {
    createDeviceConnection({ providerId: "vault" });
    createDeviceConnection({ providerId: "vault" });
    createDeviceConnection({ providerId: "passwordstate" });
    expect(performSavedCategory(["cloud_secret_storage"])).toEqual([
      { ok: false, providerId: "vault" },
    ]);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(performedSpy).not.toHaveBeenCalled();
  });

  it("preserves registered native category callbacks and removes only their owner", () => {
    const original = vi.fn(() => [{ ok: false as const, providerId: "vault" }]);
    const replacement = vi.fn(() => [
      { ok: false as const, providerId: "openbao" },
    ]);
    const releaseOriginal = registerCategorySend(
      "cloud_secret_storage",
      original,
    );
    const releaseReplacement = registerCategorySend(
      "cloud_secret_storage",
      replacement,
    );
    registerCategorySend("encryption", replacement);
    releaseOriginal();
    expect(
      performSavedCategory(["cloud_secret_storage", "encryption"]),
    ).toEqual([{ ok: false, providerId: "openbao" }]);
    expect(original).not.toHaveBeenCalled();
    expect(replacement).toHaveBeenCalledTimes(1);
    releaseReplacement();
    expect(performSavedCategory(["cloud_secret_storage"])).toEqual([]);
    expect(replacement).toHaveBeenCalledTimes(1);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(performedSpy).not.toHaveBeenCalled();
  });
});
