import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createConnection,
  setConnectionConfiguration,
  setConnectionCredential,
} from "./connections.js";
import { catalogProvider } from "./connector-catalog.js";
import { configurationPayload } from "./connector-guidance.js";
import { forgetDeviceConnectors } from "./device-connectors.js";
import { runListedFeature } from "./feature-connector-operation.js";
import { resetDeliveredModels } from "./hosted-inference.js";
import { identitySeams } from "./identity.js";
import { kvGet } from "./kv.js";
import { MODEL_PROVIDER_KEY, savedModelRequests } from "./model-provider.js";

const originalIdentity = { ...identitySeams };

function headerValues(headers: HeadersInit | undefined): string[] {
  if (!headers) return [];
  if (headers instanceof Headers) return [...headers.values()];
  if (Array.isArray(headers)) return headers.map((entry) => entry[1]);
  return Object.values(headers);
}

async function saveConnector(id: string, secret: string): Promise<void> {
  const provider = catalogProvider(id);
  if (!provider) throw new Error(id);
  const connection = await createConnection({
    providerId: provider.id,
    displayName: provider.displayName,
  });
  const values: Record<string, string> = {};
  for (const field of provider.configurationFields ?? []) {
    if (provider.authKind === "api_key" && field.name === "api_key") continue;
    values[field.name] = field.secret ? secret : `pub-${id}-${field.name}`;
  }
  if (provider.authKind === "api_key") {
    await setConnectionCredential(connection.connectionId, secret);
  }
  const payload = configurationPayload(provider, values);
  if (Object.keys(payload).length > 0) {
    await setConnectionConfiguration(connection.connectionId, payload);
  }
}

describe("savedModelRequests", () => {
  beforeEach(() => {
    identitySeams.hostBase = () => "";
    identitySeams.hostLocalSessionEligible = () => false;
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("{}", { status: 200 }),
    );
    resetDeliveredModels();
    forgetDeviceConnectors();
  });

  afterEach(() => {
    Object.assign(identitySeams, originalIdentity);
    forgetDeviceConnectors();
    vi.restoreAllMocks();
  });

  it("posts saved fields and the secret, and refuses when nothing is saved", async () => {
    const ids = ["anthropic", "azure-openai"] as const;
    const unsaved = savedModelRequests(ids.map((id) => runListedFeature(id)));
    expect(unsaved.map((row) => row.ok)).toEqual([false, false]);
    expect(vi.mocked(globalThis.fetch)).not.toHaveBeenCalled();

    await saveConnector("anthropic", "sek-anthropic-credential");
    await saveConnector("azure-openai", "sek-azure-openai-key");
    const operations = ids.map((id) => runListedFeature(id));
    const sent = savedModelRequests(operations);
    expect(sent.map((row) => row.ok)).toEqual([true, true]);

    for (const operation of operations) {
      if (!operation.ok) throw new Error(operation.providerId);
      const call = vi
        .mocked(globalThis.fetch)
        .mock.calls.find((row) =>
          Object.values(operation.secrets).every((value) =>
            headerValues(row[1]?.headers).includes(value),
          ),
        );
      expect(call, operation.providerId).toBeTruthy();
      const body = JSON.parse(String(call?.[1]?.body)) as Record<
        string,
        string
      >;
      expect(body, operation.providerId).toEqual(operation.action);
      const packed = JSON.stringify(body);
      for (const value of Object.values(operation.secrets)) {
        expect(packed, operation.providerId).not.toContain(value);
        expect(kvGet(MODEL_PROVIDER_KEY) ?? "").not.toContain(value);
      }
    }
  });
});
