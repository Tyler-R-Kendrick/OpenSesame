import type { BoundaryValue } from "@opensesame/os-domain";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defaultCapabilityConnectors } from "./capabilities.js";
import {
  clearHostSession,
  clearSession,
  connectProvisional,
} from "./identity.js";
import {
  type SecretConfig,
  branchConfig,
  compareConfigs,
  deleteConfigSecret,
  deleteSecretConfig,
  formatConfigSummary,
  listConfigKeys,
  listConfigSecretVersions,
  listSecretConfigs,
  putConfigSecrets,
  rollbackConfigSecret,
} from "./secret-configs.js";
import {
  saveSettings,
  shippedHostApi,
  shippedIdentityApi,
} from "./settings.js";

const HOST = shippedHostApi;
const IDENTITY = shippedIdentityApi;

function jsonResponse(body: BoundaryValue, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const wireConfig = {
  id: "config:prod",
  organization_id: "org:1",
  project_id: "project:1",
  slug: "production",
  display_name: "Production",
  environment: "production",
  created_at: "2026-08-20T00:00:00.000Z",
  updated_at: "2026-08-20T00:00:00.000Z",
};

function stubHostFetch(handler: (url: string, init?: RequestInit) => Response) {
  const spy = vi.fn((input: RequestInfo | URL, init?: RequestInit) =>
    Promise.resolve(handler(String(input), init)),
  );
  vi.stubGlobal("fetch", spy);
  return spy;
}

/** Session + Identity plumbing shared by every Host call in these tests. */
function withSession(handler: (url: string, init?: RequestInit) => Response) {
  return stubHostFetch((url, init) => {
    if (url === `${HOST}/api/v1/session/local`) {
      return jsonResponse({ error: "demo_bootstrap_unavailable" }, 503);
    }
    if (url === `${HOST}/api/v1/device/authorize`) {
      return jsonResponse({ device_code: "dc_sc", user_code: "ABCD-SCFG" });
    }
    if (url === `${IDENTITY}/v1/device/approve`) {
      return jsonResponse({ ok: true });
    }
    if (url === `${HOST}/api/v1/device/token`) {
      return jsonResponse({
        access_token: "opaque-session:sess_sc",
        expires_in: 28_800,
      });
    }
    if (url === `${IDENTITY}/v1/principals/me`) {
      return jsonResponse({}, 401);
    }
    return handler(url, init);
  });
}

beforeEach(async () => {
  clearSession();
  clearHostSession();
  saveSettings({
    hostApi: HOST,
    identityApi: IDENTITY,
    daemonApi: "http://127.0.0.1:18790",
    tursoUrl: "",
    mfaAppUrl: "http://127.0.0.1:5177",
    capabilityConnectors: defaultCapabilityConnectors(),
  });
  withSession(() =>
    jsonResponse({
      principalId: "principal_sc",
      accessToken: "identity_sc",
      expiresAt: "2099-01-01T00:00:00Z",
    }),
  );
  await connectProvisional();
  vi.unstubAllGlobals();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("secret-configs client", () => {
  it("lists configs for a project without secret fields", async () => {
    const spy = withSession((url) => {
      if (url === `${HOST}/api/v1/projects/project%3A1/configs`) {
        return jsonResponse({ configs: [wireConfig, null, "junk"] });
      }
      return jsonResponse({}, 404);
    });

    const configs = await listSecretConfigs("project:1");
    expect(configs).toHaveLength(1);
    expect(configs[0]).toMatchObject({
      id: "config:prod",
      organizationId: "org:1",
      projectId: "project:1",
      slug: "production",
      environment: "production",
      parentConfigId: null,
    });
    expect(
      spy.mock.calls.some(([url]) =>
        String(url).endsWith("/api/v1/projects/project%3A1/configs"),
      ),
    ).toBe(true);
    expect(JSON.stringify(configs)).not.toContain("access_token");
  });

  it("rejects config responses carrying forbidden secret keys", async () => {
    withSession((url) => {
      if (url.endsWith("/configs")) {
        return jsonResponse({
          configs: [{ ...wireConfig, value: "must-not-appear" }],
        });
      }
      return jsonResponse({}, 404);
    });
    await expect(listSecretConfigs("project:1")).rejects.toThrow(
      /forbidden key/i,
    );
  });

  it("puts secrets (the only value-carrying request) and maps key metadata", async () => {
    const spy = withSession((url, init) => {
      if (url.endsWith("/secrets") && init?.method === "PUT") {
        return jsonResponse({
          keys: [
            {
              key_name: "API_KEY",
              version: 1,
              updated_at: "2026-08-20T01:00:00.000Z",
            },
          ],
        });
      }
      return jsonResponse({}, 404);
    });

    const keys = await putConfigSecrets("config:prod", {
      API_KEY: "plain-value",
    });
    expect(keys).toEqual([
      {
        keyName: "API_KEY",
        version: 1,
        updatedAt: "2026-08-20T01:00:00.000Z",
      },
    ]);
    const request = spy.mock.calls.find(
      ([url, init]) =>
        String(url).endsWith("/secrets") && init?.method === "PUT",
    );
    expect(String(request?.[0])).toBe(
      `${HOST}/api/v1/configs/config%3Aprod/secrets`,
    );
    expect(JSON.parse(String(request?.[1]?.body))).toEqual({
      secrets: { API_KEY: "plain-value" },
    });
  });

  it("refuses a put response that echoes a value back", async () => {
    withSession((url, init) => {
      if (url.endsWith("/secrets") && init?.method === "PUT") {
        return jsonResponse({
          keys: [
            {
              key_name: "API_KEY",
              version: 1,
              updated_at: "2026-08-20T01:00:00.000Z",
              value: "echoed-back",
            },
          ],
        });
      }
      return jsonResponse({}, 404);
    });
    await expect(
      putConfigSecrets("config:prod", { API_KEY: "plain-value" }),
    ).rejects.toThrow(/forbidden key/i);
  });

  it("lists key metadata and unsets a key", async () => {
    const spy = withSession((url, init) => {
      if (init?.method === "DELETE") {
        return new Response(null, { status: 204 });
      }
      if (url.endsWith("/secrets")) {
        return jsonResponse({
          keys: [
            {
              key_name: "DB_URL",
              version: 3,
              updated_at: "2026-08-20T02:00:00.000Z",
            },
          ],
        });
      }
      return jsonResponse({}, 404);
    });

    const keys = await listConfigKeys("config:prod");
    expect(keys[0]).toMatchObject({ keyName: "DB_URL", version: 3 });
    await expect(
      deleteConfigSecret("config:prod", "DB_URL"),
    ).resolves.toBeUndefined();
    const request = spy.mock.calls.find(
      ([, init]) => init?.method === "DELETE",
    );
    expect(String(request?.[0])).toBe(
      `${HOST}/api/v1/configs/config%3Aprod/secrets/DB_URL`,
    );
  });

  it("lists version metadata and rolls back with to_version", async () => {
    const spy = withSession((url, init) => {
      if (url.endsWith("/rollback") && init?.method === "POST") {
        return jsonResponse({ key_name: "DB_URL", version: 4 });
      }
      if (url.endsWith("/versions")) {
        return jsonResponse({
          versions: [
            {
              version: 1,
              deleted: false,
              actor_id: "principal:1",
              created_at: "2026-08-20T00:00:00.000Z",
            },
            {
              version: 2,
              deleted: true,
              actor_id: null,
              created_at: "2026-08-20T01:00:00.000Z",
            },
          ],
        });
      }
      return jsonResponse({}, 404);
    });

    const versions = await listConfigSecretVersions("config:prod", "DB_URL");
    expect(versions).toEqual([
      {
        version: 1,
        deleted: false,
        actorId: "principal:1",
        createdAt: "2026-08-20T00:00:00.000Z",
      },
      {
        version: 2,
        deleted: true,
        actorId: null,
        createdAt: "2026-08-20T01:00:00.000Z",
      },
    ]);

    const rolled = await rollbackConfigSecret("config:prod", "DB_URL", 1);
    expect(rolled).toEqual({ keyName: "DB_URL", version: 4 });
    const request = spy.mock.calls.find(([url]) =>
      String(url).endsWith("/rollback"),
    );
    expect(String(request?.[0])).toBe(
      `${HOST}/api/v1/configs/config%3Aprod/secrets/DB_URL/rollback`,
    );
    expect(JSON.parse(String(request?.[1]?.body))).toEqual({ to_version: 1 });
  });

  it("compares configs by presence and versions only", async () => {
    withSession((url) => {
      if (url.includes("/compare/")) {
        return jsonResponse({
          only_in_a: ["ONLY_A"],
          only_in_b: [],
          in_both: [{ key_name: "SHARED", a_version: 2, b_version: 5 }],
        });
      }
      return jsonResponse({}, 404);
    });

    const diff = await compareConfigs("config:prod", "config:dev");
    expect(diff).toEqual({
      onlyInA: ["ONLY_A"],
      onlyInB: [],
      inBoth: [{ keyName: "SHARED", aVersion: 2, bVersion: 5 }],
    });
  });

  it("branches a config and surfaces refusal hints", async () => {
    const spy = withSession((url, init) => {
      if (url.endsWith("/branch") && init?.method === "POST") {
        return jsonResponse(
          {
            ...wireConfig,
            id: "config:child",
            slug: "dev-tyler",
            parent_config_id: "config:prod",
          },
          201,
        );
      }
      return jsonResponse({}, 404);
    });

    const child = await branchConfig("config:prod", { slug: "dev-tyler" });
    expect(child.parentConfigId).toBe("config:prod");
    const request = spy.mock.calls.find(([url]) =>
      String(url).endsWith("/branch"),
    );
    expect(JSON.parse(String(request?.[1]?.body))).toEqual({
      slug: "dev-tyler",
    });

    clearHostSession();
    withSession((url) => {
      if (url.endsWith("/branch")) {
        return jsonResponse({ hint: "slug already used" }, 409);
      }
      return jsonResponse({}, 404);
    });
    await expect(
      branchConfig("config:prod", { slug: "dev-tyler" }),
    ).rejects.toThrow(/slug already used/);
  });

  it("deletes a config, accepting 204 but not other failures", async () => {
    withSession((url, init) => {
      if (init?.method === "DELETE") {
        return new Response(null, { status: 204 });
      }
      return jsonResponse({}, 404);
    });
    await expect(deleteSecretConfig("config:prod")).resolves.toBeUndefined();

    clearHostSession();
    withSession((_url, init) =>
      init?.method === "DELETE" ? jsonResponse({}, 409) : jsonResponse({}, 404),
    );
    await expect(deleteSecretConfig("config:prod")).rejects.toThrow(
      /Delete secret config failed \(409\)/,
    );
  });

  it("rejects payloads whose strings look like secret material", async () => {
    const leak = `sk_${"a".repeat(80)}`;
    withSession((url) => {
      if (url.endsWith("/configs")) {
        return jsonResponse({ configs: [], note: leak });
      }
      return jsonResponse({}, 404);
    });
    await expect(listSecretConfigs("project:1")).rejects.toThrow(
      /secret material/,
    );
  });

  it("summarizes a config for the picker row", () => {
    const config: SecretConfig = {
      id: "config:prod",
      organizationId: "org:1",
      projectId: "project:1",
      slug: "production",
      displayName: "Production API",
      environment: "production",
      parentConfigId: null,
      createdAt: "2026-08-20T00:00:00.000Z",
      updatedAt: "2026-08-20T00:00:00.000Z",
    };
    expect(formatConfigSummary(config)).toBe(
      "production · production · Production API",
    );
    expect(
      formatConfigSummary({
        ...config,
        displayName: "production",
        parentConfigId: "config:parent",
      }),
    ).toBe("production · production · branch");
  });
});
