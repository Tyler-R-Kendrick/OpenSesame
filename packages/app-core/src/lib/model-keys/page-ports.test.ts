import { afterEach, describe, expect, it } from "vitest";
import { modelApiOf } from "../ai-model-provider.js";
import { catalogProviders } from "../connector-catalog.js";
import { clearModelKeyAuditEvents, modelKeyAuditEvents } from "./audit-ring.js";
import {
  keyedModelProviders,
  modelTargetForResource,
  pageModelKeyPorts,
} from "./page-ports.js";

describe("which providers a key can be for", () => {
  it("names the provider a resource indicator points at", () => {
    expect(modelTargetForResource("https://api.openai.com/v1")).toMatchObject({
      providerId: "openai",
      protocol: "openai_chat",
    });
    expect(
      modelTargetForResource("https://api.anthropic.com/v1")?.protocol,
    ).toBe("anthropic_messages");
  });

  it("does not repair a spelling: the same URL written another way is no resource at all", () => {
    for (const resource of [
      "https://api.openai.com/v1/",
      "https://API.OpenAI.com/v1",
      "https://api.openai.com/v1/./",
      "https://api.openai.com/v1?x=1",
      "https://api.openai.com/v1#f",
    ])
      expect(modelTargetForResource(resource), resource).toBeNull();
  });

  it("knows no host the catalog does not name", () => {
    for (const resource of [
      "https://api.openai.com.evil.example.test/v1",
      "https://api.openai.com/v2",
      "http://api.openai.com/v1",
      "https://api.openai.com:8443/v1",
      "https://user@api.openai.com/v1",
      "not a url",
      "",
    ])
      expect(modelTargetForResource(resource), resource).toBeNull();
  });

  it("offers a key only where every route can be inspected", () => {
    const offered = keyedModelProviders();
    expect(offered.length).toBeGreaterThan(10);
    for (const target of offered) {
      expect([
        "openai_chat",
        "anthropic_messages",
        "gemini_generate_content",
      ]).toContain(target.protocol);
      expect(target.baseUrl.startsWith("https://")).toBe(true);
    }
    const restOnly = catalogProviders().filter(
      (provider) => modelApiOf(provider.id)?.protocol === "rest_json",
    );
    expect(restOnly.length).toBeGreaterThan(0);
    for (const provider of restOnly)
      expect(
        offered.some((target) => target.providerId === provider.id),
        provider.id,
      ).toBe(false);
  });

  it("offers none for a row whose endpoint is the person's own", () => {
    const own = catalogProviders().filter(
      (provider) =>
        modelApiOf(provider.id) && !modelApiOf(provider.id)?.baseUrl,
    );
    for (const provider of own)
      expect(
        keyedModelProviders().some((t) => t.providerId === provider.id),
      ).toBe(false);
  });

  it("leaves out only rows whose base URL is not a canonical resource", () => {
    const offered = new Set(keyedModelProviders().map((t) => t.providerId));
    for (const provider of catalogProviders()) {
      const api = modelApiOf(provider.id);
      if (!api?.baseUrl || api.protocol === "rest_json") continue;
      if (offered.has(provider.id)) continue;
      // Not offered: another row already holds the host, or the URL is not strict.
      const twin = keyedModelProviders().find((t) => t.baseUrl === api.baseUrl);
      expect(
        twin !== undefined ||
          !/^https:\/\/[a-z0-9.-]+(\/[A-Za-z0-9._-]+)*$/.test(api.baseUrl),
        provider.id,
      ).toBe(true);
    }
  });

  it("gives one provider per host, so a resource is never ambiguous", () => {
    const hosts = keyedModelProviders().map((target) => target.baseUrl);
    expect(new Set(hosts).size).toBe(hosts.length);
  });
});

afterEach(clearModelKeyAuditEvents);

describe("the page's ports", () => {
  it("passes the connection's facts through and forwards audit events", () => {
    const seen: string[] = [];
    const ports = pageModelKeyPorts({
      connection: (id) => ({
        connectionId: id,
        providerId: "openai",
        verified: true,
      }),
      audit: (event) => seen.push(event.type),
    });
    expect(ports.connection("c1")).toEqual({
      connectionId: "c1",
      providerId: "openai",
      verified: true,
    });
    ports.audit({ type: "key.revoked", at: 1, keyId: "k" });
    expect(seen).toEqual(["key.revoked"]);
  });

  it("still tells watchers when the page's own sink throws", () => {
    const ports = pageModelKeyPorts({
      connection: () => null,
      audit: () => {
        throw new Error("sink down");
      },
    });
    expect(() => ports.audit({ type: "key.revoked", at: 1 })).toThrow(
      "sink down",
    );
  });
});

describe("the page's audit trail", () => {
  it("keeps every event the broker emits, with no sink of the page's own", () => {
    const ports = pageModelKeyPorts({ connection: () => null });
    ports.audit({ type: "root.issued", at: 1, keyId: "mk_a" });
    ports.audit({ type: "exchange.refused", at: 2, reason: "param.unknown" });
    expect(modelKeyAuditEvents()).toEqual([
      { type: "root.issued", at: 1, keyId: "mk_a" },
      { type: "exchange.refused", at: 2, reason: "param.unknown" },
    ]);
  });

  it("keeps the event even when the page's own sink throws", () => {
    const ports = pageModelKeyPorts({
      connection: () => null,
      audit: () => {
        throw new Error("sink down");
      },
    });
    expect(() => ports.audit({ type: "key.revoked", at: 1 })).toThrow();
    expect(modelKeyAuditEvents()).toHaveLength(1);
  });
});
