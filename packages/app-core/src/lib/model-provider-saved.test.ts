import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { planWith } from "./capabilities/__tests__/plan-with.js";
import { CAPABILITY_CATALOG } from "./capabilities/catalog.js";
import { createEgressPort } from "./capabilities/egress.js";
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

  it("posts saved fields and the secret through egress, and refuses when nothing is saved", async () => {
    const descriptor = CAPABILITY_CATALOG.capabilities.find(
      (row) => row.id === "support.remote-ai",
    );
    if (!descriptor) throw new Error("catalog lacks support.remote-ai");
    const posted: string[] = [];
    const egress = createEgressPort({
      capability: descriptor,
      plan: () => planWith(["support.remote-ai"]),
      allowedOrigins: ["https://app.example.test"],
      fetchImpl: async (input) => {
        posted.push(String(input));
        return new Response("{}", { status: 200 });
      },
    });

    const ids = ["anthropic", "azure-openai"] as const;
    const unsaved = savedModelRequests(
      ids.map((id) => runListedFeature(id)),
      {
        egress,
      },
    );
    expect(unsaved.map((row) => row.ok)).toEqual([false, false]);
    expect(posted).toEqual([]);
    expect(vi.mocked(globalThis.fetch)).not.toHaveBeenCalled();

    await saveConnector("anthropic", "sek-anthropic-credential");
    await saveConnector("azure-openai", "sek-azure-openai-key");
    const operations = ids.map((id) => runListedFeature(id));
    const sent = savedModelRequests(operations, { egress });
    expect(sent.map((row) => row.ok)).toEqual([true, false]);

    const operation = operations[0];
    if (!operation.ok) throw new Error(operation.providerId);
    expect(posted.length).toBe(1);
    expect(posted[0]).toMatch(/^https:\/\/api\.anthropic\.com\//);
    const packed = JSON.stringify(operation.action);
    for (const value of Object.values(operation.secrets)) {
      expect(packed, operation.providerId).not.toContain(value);
      expect(kvGet(MODEL_PROVIDER_KEY) ?? "").not.toContain(value);
    }
    expect(vi.mocked(globalThis.fetch)).not.toHaveBeenCalled();
  });

  it("does not post when no egress port is supplied", async () => {
    await saveConnector("anthropic", "sek-anthropic-credential");
    const sent = savedModelRequests([runListedFeature("anthropic")]);
    expect(sent[0]?.ok).toBe(true);
    expect(vi.mocked(globalThis.fetch)).not.toHaveBeenCalled();
  });
});
