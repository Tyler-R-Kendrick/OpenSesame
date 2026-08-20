import { describe, expect, it } from "vitest";
import {
  ClientAdmissionError,
  createClientAdmissionPolicy,
} from "../clients/admission.js";
import {
  findOriginClient,
  resolveOriginClient,
  toOidcClientMetadata,
} from "../clients/origin-resolve.js";
import { MemoryClientRecordStore } from "../clients/store.js";
import type { OAuthClientRecord } from "../types.js";

const DEV = { allowLoopbackHttp: true, production: false } as const;

function enabledAdmission() {
  return createClientAdmissionPolicy({
    originClientsEnabled: true,
    dcrEnabled: false,
    cimdEnabled: false,
  });
}

function disabledAdmission() {
  return createClientAdmissionPolicy({
    originClientsEnabled: false,
    dcrEnabled: false,
    cimdEnabled: false,
  });
}

describe("resolveOriginClient", () => {
  it("auto-admits a first-seen origin with the fixed public-client profile", async () => {
    const store = new MemoryClientRecordStore();
    const client = await resolveOriginClient({
      store,
      admission: enabledAdmission(),
      origin: "http://127.0.0.1:4101",
      ...DEV,
    });

    expect(client.id).toBe("origin:http://127.0.0.1:4101");
    expect(client.admissionMode).toBe("origin_profile");
    expect(client.origin).toBe("http://127.0.0.1:4101");
    expect(client.ownershipStatus).toBe("unclaimed");
    expect(client.redirectUris).toEqual([
      "http://127.0.0.1:4101/opensesame/callback",
    ]);
    expect(client.grantTypes).toEqual(["authorization_code"]);
    expect(client.responseTypes).toEqual(["code"]);
    expect(client.tokenEndpointAuthMethod).toBe("none");
    expect(client.allowedScopes).toEqual(["openid"]);
    expect(client.state).toBe("active");
    expect(client.sectorIdentifier).toBeTruthy();
    expect(client.firstSeenAt).toBeInstanceOf(Date);
    expect(client.lastUsedAt).toBeInstanceOf(Date);

    // Persisted: findable by id and by origin.
    expect(await store.findById(client.id)).toEqual(client);
    expect(await store.findByOrigin(client.origin as string)).toEqual(client);
  });

  it("returns the same client (stable sector) on repeat admission", async () => {
    const store = new MemoryClientRecordStore();
    const admission = enabledAdmission();
    const first = await resolveOriginClient({
      store,
      admission,
      origin: "http://127.0.0.1:4101",
      ...DEV,
    });
    const second = await resolveOriginClient({
      store,
      admission,
      origin: "HTTP://127.0.0.1:4101/",
      ...DEV,
    });
    expect(second.id).toBe(first.id);
    expect(second.sectorIdentifier).toBe(first.sectorIdentifier);
  });

  it("touches lastUsedAt on repeat admission", async () => {
    const store = new MemoryClientRecordStore();
    const admission = enabledAdmission();
    let now = new Date("2026-01-01T00:00:00.000Z");
    const clock = () => now;
    await resolveOriginClient({
      store,
      admission,
      origin: "http://127.0.0.1:4101",
      clock,
      ...DEV,
    });
    now = new Date("2026-01-02T00:00:00.000Z");
    const again = await resolveOriginClient({
      store,
      admission,
      origin: "http://127.0.0.1:4101",
      clock,
      ...DEV,
    });
    // The returned record is the pre-touch load; the touch lands in the store.
    expect(again.id).toBeTruthy();
    const persisted = await store.findById(again.id);
    expect(persisted?.lastUsedAt).toEqual(now);
    expect(persisted?.firstSeenAt).toEqual(
      new Date("2026-01-01T00:00:00.000Z"),
    );
  });

  it("gives port-distinct origins distinct clients and sectors", async () => {
    const store = new MemoryClientRecordStore();
    const admission = enabledAdmission();
    const a = await resolveOriginClient({
      store,
      admission,
      origin: "http://127.0.0.1:4101",
      ...DEV,
    });
    const b = await resolveOriginClient({
      store,
      admission,
      origin: "http://127.0.0.1:4102",
      ...DEV,
    });
    expect(a.id).not.toBe(b.id);
    expect(a.sectorIdentifier).not.toBe(b.sectorIdentifier);
  });

  it("throws when origin_profile admission is disabled", async () => {
    const store = new MemoryClientRecordStore();
    await expect(
      resolveOriginClient({
        store,
        admission: disabledAdmission(),
        origin: "https://app.example.com",
        production: true,
      }),
    ).rejects.toThrow(/disabled/);
  });

  it("rejects an existing record that violates admission policy", async () => {
    const store = new MemoryClientRecordStore();
    const admission = enabledAdmission();
    const canonical = "https://app.example.com";
    const malicious: OAuthClientRecord = {
      id: `origin:${canonical}`,
      admissionMode: "origin_profile",
      displayName: "Tampered",
      redirectUris: [`${canonical}/opensesame/callback`],
      sectorIdentifier: "sector-x",
      grantTypes: ["authorization_code", "client_credentials"],
      responseTypes: ["code"],
      tokenEndpointAuthMethod: "none",
      allowedScopes: ["openid", "offline_access"],
      allowedResources: [],
      state: "active",
      origin: canonical,
    };
    await store.insertAtomic(malicious);

    await expect(
      resolveOriginClient({
        store,
        admission,
        origin: canonical,
        production: true,
      }),
    ).rejects.toThrow(ClientAdmissionError);
  });

  it("rejects a suspended existing client", async () => {
    const store = new MemoryClientRecordStore();
    const admission = enabledAdmission();
    const admitted = await resolveOriginClient({
      store,
      admission,
      origin: "http://127.0.0.1:4101",
      ...DEV,
    });
    // Suspend out-of-band (durable suspend/revoke is a later slice; the
    // admission fence must already honor the state).
    const suspended: OAuthClientRecord = { ...admitted, state: "suspended" };
    const directStore = new MemoryClientRecordStore();
    await directStore.insertAtomic(suspended);
    await expect(
      resolveOriginClient({
        store: directStore,
        admission,
        origin: "http://127.0.0.1:4101",
        ...DEV,
      }),
    ).rejects.toThrow(ClientAdmissionError);
  });
});

describe("findOriginClient", () => {
  it("never inserts: unknown origin → undefined, store stays empty", async () => {
    const store = new MemoryClientRecordStore();
    const found = await findOriginClient({
      store,
      admission: enabledAdmission(),
      origin: "http://127.0.0.1:4101",
      ...DEV,
    });
    expect(found).toBeUndefined();
    expect(await store.findByOrigin("http://127.0.0.1:4101")).toBeUndefined();
  });

  it("finds an already-admitted client without mutating it", async () => {
    const store = new MemoryClientRecordStore();
    const admission = enabledAdmission();
    let now = new Date("2026-01-01T00:00:00.000Z");
    const clock = () => now;
    const admitted = await resolveOriginClient({
      store,
      admission,
      origin: "http://127.0.0.1:4101",
      clock,
      ...DEV,
    });
    now = new Date("2026-01-02T00:00:00.000Z");
    const found = await findOriginClient({
      store,
      admission,
      origin: "http://127.0.0.1:4101",
      clock,
      ...DEV,
    });
    expect(found?.id).toBe(admitted.id);
    // Lookup-only: no lastUsedAt touch.
    expect(found?.lastUsedAt).toEqual(admitted.lastUsedAt);
  });

  it("returns undefined when origin_profile admission is disabled", async () => {
    const store = new MemoryClientRecordStore();
    const admission = enabledAdmission();
    await resolveOriginClient({
      store,
      admission,
      origin: "http://127.0.0.1:4101",
      ...DEV,
    });
    const found = await findOriginClient({
      store,
      admission: disabledAdmission(),
      origin: "http://127.0.0.1:4101",
      ...DEV,
    });
    expect(found).toBeUndefined();
  });
});

describe("toOidcClientMetadata", () => {
  it("pins the public-client profile and pairwise subject type", async () => {
    const store = new MemoryClientRecordStore();
    const client = await resolveOriginClient({
      store,
      admission: enabledAdmission(),
      origin: "http://127.0.0.1:4101",
      ...DEV,
    });
    const meta = toOidcClientMetadata(client);
    expect(meta).toEqual({
      client_id: "origin:http://127.0.0.1:4101",
      client_name: client.displayName,
      redirect_uris: ["http://127.0.0.1:4101/opensesame/callback"],
      grant_types: ["authorization_code"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
      scope: "openid",
      subject_type: "pairwise",
      application_type: "web",
    });
  });

  it("maps allowedScopes onto the oidc-provider scope allowlist", () => {
    const meta = toOidcClientMetadata({
      id: "origin-app",
      admissionMode: "origin_profile",
      displayName: "Origin App",
      redirectUris: ["https://app.example/cb"],
      sectorIdentifier: "https://app.example",
      grantTypes: ["authorization_code"],
      responseTypes: ["code"],
      tokenEndpointAuthMethod: "none",
      allowedScopes: ["openid", "profile"],
      allowedResources: [],
      state: "active",
      origin: "https://app.example",
    });
    expect(meta.scope).toBe("openid profile");
  });

  it("falls back to openid when allowedScopes is empty", () => {
    const meta = toOidcClientMetadata({
      id: "origin-app",
      admissionMode: "origin_profile",
      displayName: "Origin App",
      redirectUris: ["https://app.example/cb"],
      sectorIdentifier: "https://app.example",
      grantTypes: ["authorization_code"],
      responseTypes: ["code"],
      tokenEndpointAuthMethod: "none",
      allowedScopes: [],
      allowedResources: [],
      state: "active",
      origin: "https://app.example",
    });
    expect(meta.scope).toBe("openid");
  });
});
