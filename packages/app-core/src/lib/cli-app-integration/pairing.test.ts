import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { takeStorageWrites } from "../../test-host-storage-writes.js";
import { localNetworkFetchSeams } from "../local-network-fetch.js";
import { ownsWebStorageKey } from "../storage-ownership.js";
import {
  CLI_APP_INTEGRATION_BEARER_KEY,
  clearCliAppIntegrationBearer,
  readCliAppIntegrationBearer,
} from "./bearer-session.js";
import {
  type CliAppPairingCode,
  cliAppPairingRefusalMessage,
  exchangeCliAppPairingCode,
} from "./pairing.js";

const parsed: CliAppPairingCode = {
  code: "A".repeat(43),
  origin: "http://localhost:5180",
  url: "http://127.0.0.1:18790",
  label: "CLI",
};

function memoryStorage(): Storage {
  const items = new Map<string, string>();
  return {
    get length() {
      return items.size;
    },
    clear() {
      items.clear();
    },
    getItem(key: string) {
      return items.get(key) ?? null;
    },
    key(index: number) {
      return [...items.keys()][index] ?? null;
    },
    removeItem(key: string) {
      items.delete(key);
    },
    setItem(key: string, value: string) {
      items.set(key, value);
    },
  };
}

const eligible = localNetworkFetchSeams.eligible;
beforeEach(() => {
  // These tests exercise pairing refusals, not the deployment fence; the
  // loopback test origin is a local-authority deployment.
  localNetworkFetchSeams.eligible = () => true;
  vi.stubGlobal("sessionStorage", memoryStorage());
});

afterEach(() => {
  localNetworkFetchSeams.eligible = eligible;
  clearCliAppIntegrationBearer();
  const unowned = takeStorageWrites().filter(
    (write) => !ownsWebStorageKey(write.key, write.area),
  );
  expect(
    unowned.every((write) => write.key === CLI_APP_INTEGRATION_BEARER_KEY),
  ).toBe(true);
  vi.unstubAllGlobals();
});

describe("CLI pairing refusals", () => {
  it("keeps a registration refusal distinct from a generic pairing refusal", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({ error: "pairing_registration_required" }),
            {
              status: 403,
              headers: { "content-type": "application/json" },
            },
          ),
      ),
    );
    const result = await exchangeCliAppPairingCode(parsed);
    expect(result).toEqual({
      ok: false,
      code: "pairing_registration_required",
      message: cliAppPairingRefusalMessage("pairing_registration_required"),
    });
    expect(cliAppPairingRefusalMessage("pairing_expired")).not.toBe(
      cliAppPairingRefusalMessage("invalid_proof"),
    );
    expect(cliAppPairingRefusalMessage("not_a_real_code")).toBe(
      "Pairing was refused (not_a_real_code).",
    );
  });

  it("drops the bearer when the passkey cannot be registered", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ token: "B".repeat(43) }), {
            status: 201,
            headers: { "content-type": "application/json" },
          }),
      ),
    );
    const result = await exchangeCliAppPairingCode(parsed);
    expect(result).toMatchObject({ ok: false, code: "vault_locked" });
    expect(readCliAppIntegrationBearer()).toBeNull();
  });
});
