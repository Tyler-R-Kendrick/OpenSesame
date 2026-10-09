import { describe, expect, it, vi } from "vitest";
import { readDeviceSecrets } from "./device-connector-records.js";
import { kvSeams } from "./kv.js";
import {
  configureLinearConnector,
  readLinearConnector,
} from "./linear-connectors.js";
import {
  installLinearProvider,
  installLinearRuntimeTests,
  linearDraft,
  linearOptions,
} from "./linear-runtime.test-support.js";
import {
  configureLinearWebhooks,
  removeLinearWebhook,
} from "./linear-webhooks.js";

installLinearRuntimeTests();
const options = {
  ...linearOptions,
  webhookEnabled: true,
  webhookUrl: "https://hooks.example.org/linear",
  webhookResourceTypes: ["Issue", "Comment"],
};

describe("provider-backed durable webhook setup", () => {
  it("creates the selected subscription with a stable ID and removes it at Linear", async () => {
    const provider = installLinearProvider();
    const saved = await configureLinearConnector(linearDraft(), options);
    const webhook = readLinearConnector(saved.connectionId)?.webhook;
    expect(webhook?.resourceTypes).toEqual(["Issue", "Comment"]);
    expect(provider.created).toEqual([webhook?.id]);
    expect(provider.hooks.get(webhook?.id ?? "")?.url).toBe(options.webhookUrl);
    expect(
      readDeviceSecrets()[saved.connectionId]?.linear_webhook_secret,
    ).toHaveLength(64);
    await removeLinearWebhook(saved.connectionId);
    expect(provider.deleted).toEqual([webhook?.id]);
    expect(provider.hooks.size).toBe(0);
    expect(readLinearConnector(saved.connectionId)?.webhook).toBeNull();
    expect(
      readDeviceSecrets()[saved.connectionId]?.linear_webhook_secret,
    ).toBeUndefined();
  });

  it("preserves webhook signing credentials when editing an API-key connector", async () => {
    const provider = installLinearProvider();
    const saved = await configureLinearConnector(linearDraft(), options);
    const secret =
      readDeviceSecrets()[saved.connectionId]?.linear_webhook_secret;
    await configureLinearConnector(
      { ...linearDraft(), name: "Renamed", key: "" },
      options,
      saved.connectionId,
    );
    expect(readDeviceSecrets()[saved.connectionId]?.linear_webhook_secret).toBe(
      secret,
    );
    expect(provider.created).toHaveLength(1);
  });

  it("recovers a successful provider creation whose response was lost", async () => {
    const provider = installLinearProvider();
    provider.loseCreateReply = true;
    const saved = await configureLinearConnector(linearDraft(), options);
    expect(provider.created).toHaveLength(1);
    expect(readLinearConnector(saved.connectionId)?.webhook?.id).toBe(
      provider.created[0],
    );
    expect(
      readDeviceSecrets()[saved.connectionId]?.linear_webhook_intent,
    ).toBeUndefined();
  });

  it("keeps the intent after a failed durable completion and resumes without creating a duplicate", async () => {
    const provider = installLinearProvider();
    provider.onCreate = () => {
      vi.mocked(kvSeams.kvSetDurable).mockRejectedValueOnce(
        new Error("Webhook storage failed"),
      );
    };
    await expect(
      configureLinearConnector(linearDraft(), options),
    ).rejects.toThrow("Webhook storage failed");
    const id = Object.keys(readDeviceSecrets())[0];
    if (!id) throw new Error("Committed connector intent missing");
    const intent = readDeviceSecrets()[id]?.linear_webhook_intent;
    expect(intent).toContain(provider.created[0]);
    expect(readLinearConnector(id)?.webhook).toBeNull();
    await configureLinearWebhooks(id);
    expect(provider.created).toHaveLength(1);
    expect(readLinearConnector(id)?.webhook?.id).toBe(provider.created[0]);
    expect(readDeviceSecrets()[id]?.linear_webhook_intent).toBeUndefined();
  });

  it("creates nothing when the initial durable intent cannot be saved", async () => {
    const provider = installLinearProvider();
    const initialWrite = vi
      .mocked(kvSeams.kvSetDurable)
      .getMockImplementation();
    if (!initialWrite) throw new Error("Missing storage test seam");
    vi.mocked(kvSeams.kvSetDurable).mockImplementation(async (key, value) => {
      if (value.includes("linear_webhook_intent"))
        throw new Error("Intent storage failed");
      return initialWrite(key, value);
    });
    await expect(
      configureLinearConnector(linearDraft(), options),
    ).rejects.toThrow("Intent storage failed");
    expect(provider.created).toHaveLength(0);
  });

  it("reconciles a delete whose response was lost", async () => {
    const provider = installLinearProvider();
    const saved = await configureLinearConnector(linearDraft(), options);
    provider.loseDeleteReply = true;
    await removeLinearWebhook(saved.connectionId);
    expect(provider.deleted).toHaveLength(1);
    expect(readLinearConnector(saved.connectionId)?.webhook).toBeNull();
  });

  it("retries local deletion without deleting the already absent provider subscription again", async () => {
    const provider = installLinearProvider();
    const saved = await configureLinearConnector(linearDraft(), options);
    provider.onDelete = () => {
      vi.mocked(kvSeams.kvSetDurable).mockRejectedValueOnce(
        new Error("Delete storage failed"),
      );
    };
    await expect(removeLinearWebhook(saved.connectionId)).rejects.toThrow(
      "Delete storage failed",
    );
    expect(provider.hooks.size).toBe(0);
    expect(readLinearConnector(saved.connectionId)?.webhook).not.toBeNull();
    await removeLinearWebhook(saved.connectionId);
    expect(provider.deleted).toHaveLength(1);
    expect(readLinearConnector(saved.connectionId)?.webhook).toBeNull();
  });
});
