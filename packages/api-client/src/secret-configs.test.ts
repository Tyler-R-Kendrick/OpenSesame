import type { BoundaryValue } from "@opensesame/os-domain";
import { describe, expect, it } from "vitest";
import { createApiClient } from "./index.js";

const config = {
  id: "config_01J",
  organization_id: "organization_01J",
  project_id: "project_01J",
  slug: "production",
  display_name: "Production",
  environment: "production",
  created_at: "2026-08-20T10:00:00.000Z",
  updated_at: "2026-08-20T10:00:00.000Z",
};

const keyMeta = {
  key_name: "DATABASE_URL",
  version: 2,
  updated_at: "2026-08-20T10:05:00.000Z",
};

function jsonClient(handler: (url: string, init?: RequestInit) => Response) {
  const calls: { url: string; method: string; body: string }[] = [];
  const client = createApiClient({
    baseUrl: "https://host.test:8787",
    fetchImpl: async (input, init) => {
      calls.push({
        url: String(input),
        method: String(init?.method ?? "GET"),
        body: String(init?.body ?? ""),
      });
      return handler(String(input), init);
    },
  });
  return { calls, client };
}

function ok(body: BoundaryValue, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

describe("api-client secret configs", () => {
  it("lists and creates configs under the project path", async () => {
    const { client, calls } = jsonClient((_url, init) =>
      init?.method === "POST" ? ok(config, 201) : ok({ configs: [config] }),
    );

    const listed = await client.listSecretConfigs("project_01J");
    const created = await client.createSecretConfig("project_01J", {
      slug: "production",
      environment: "production",
    });

    expect(listed.configs).toHaveLength(1);
    expect(created.environment).toBe("production");
    expect(calls[0]?.url).toBe(
      "https://host.test:8787/api/v1/projects/project_01J/configs",
    );
    expect(calls[0]?.method).toBe("GET");
    expect(calls[1]?.method).toBe("POST");
    expect(JSON.parse(calls[1]?.body ?? "{}")).toEqual({
      slug: "production",
      environment: "production",
    });
  });

  it("reads and deletes a config by id", async () => {
    const { client, calls } = jsonClient((_url, init) =>
      init?.method === "DELETE"
        ? new Response(null, { status: 204 })
        : ok(config),
    );

    const fetched = await client.getSecretConfig("config_01J");
    await client.deleteSecretConfig("config_01J");

    expect(fetched.id).toBe("config_01J");
    expect(calls[0]?.url).toBe(
      "https://host.test:8787/api/v1/configs/config_01J",
    );
    expect(calls[1]?.method).toBe("DELETE");
    expect(calls[1]?.url).toBe(
      "https://host.test:8787/api/v1/configs/config_01J",
    );
  });

  it("surfaces delete refusals with the broker error code", async () => {
    const { client } = jsonClient(
      () =>
        new Response(JSON.stringify({ error: "config_in_use" }), {
          status: 409,
        }),
    );
    await expect(client.deleteSecretConfig("config_01J")).rejects.toThrow(
      "secret_config_delete_failed:409:config_in_use",
    );
  });

  it("puts secrets and gets back key names + versions only", async () => {
    const { client, calls } = jsonClient(() => ok({ keys: [keyMeta] }));

    const res = await client.putConfigSecrets("config_01J", {
      secrets: { DATABASE_URL: "postgres://u@h/db" },
    });

    expect(res.keys[0]?.key_name).toBe("DATABASE_URL");
    expect(calls[0]?.method).toBe("PUT");
    expect(calls[0]?.url).toBe(
      "https://host.test:8787/api/v1/configs/config_01J/secrets",
    );
    expect(JSON.parse(calls[0]?.body ?? "{}")).toEqual({
      secrets: { DATABASE_URL: "postgres://u@h/db" },
    });
  });

  it("lists key metadata and deletes a single key", async () => {
    const { client, calls } = jsonClient((_url, init) =>
      init?.method === "DELETE"
        ? new Response(null, { status: 204 })
        : ok({ keys: [keyMeta] }),
    );

    const res = await client.listConfigKeys("config_01J");
    await client.deleteConfigSecret("config_01J", "DATABASE_URL");

    expect(res.keys).toHaveLength(1);
    expect(calls[0]?.method).toBe("GET");
    expect(calls[0]?.url).toBe(
      "https://host.test:8787/api/v1/configs/config_01J/secrets",
    );
    expect(calls[1]?.method).toBe("DELETE");
    expect(calls[1]?.url).toBe(
      "https://host.test:8787/api/v1/configs/config_01J/secrets/DATABASE_URL",
    );
  });

  it("lists version metadata and rolls back to an older version", async () => {
    const { client, calls } = jsonClient((url) =>
      url.endsWith("/rollback")
        ? ok({ key_name: "DATABASE_URL", version: 3 })
        : ok({
            versions: [
              {
                version: 1,
                deleted: false,
                actor_id: "principal_01J",
                created_at: "2026-08-20T10:00:00.000Z",
              },
              {
                version: 2,
                deleted: false,
                actor_id: null,
                created_at: "2026-08-20T10:05:00.000Z",
              },
            ],
          }),
    );

    const versions = await client.listConfigSecretVersions(
      "config_01J",
      "DATABASE_URL",
    );
    const rolled = await client.rollbackConfigSecret(
      "config_01J",
      "DATABASE_URL",
      1,
    );

    expect(versions.versions).toHaveLength(2);
    expect(rolled.version).toBe(3);
    expect(calls[0]?.url).toBe(
      "https://host.test:8787/api/v1/configs/config_01J/secrets/DATABASE_URL/versions",
    );
    expect(calls[1]?.method).toBe("POST");
    expect(calls[1]?.url).toBe(
      "https://host.test:8787/api/v1/configs/config_01J/secrets/DATABASE_URL/rollback",
    );
    expect(calls[1]?.body).toBe('{"to_version":1}');
  });

  it("compares two configs by presence and versions only", async () => {
    const { client, calls } = jsonClient(() =>
      ok({
        only_in_a: ["ONLY_A"],
        only_in_b: ["ONLY_B"],
        in_both: [{ key_name: "SHARED", a_version: 1, b_version: 4 }],
      }),
    );

    const diff = await client.compareConfigs("config_a", "config_b");
    expect(diff.only_in_a).toEqual(["ONLY_A"]);
    expect(diff.in_both[0]?.b_version).toBe(4);
    expect(calls[0]?.url).toBe(
      "https://host.test:8787/api/v1/configs/config_a/compare/config_b",
    );
  });

  it("branches a config into a child", async () => {
    const { client, calls } = jsonClient(() =>
      ok(
        { ...config, id: "config_child", parent_config_id: "config_01J" },
        201,
      ),
    );

    const child = await client.branchConfig("config_01J", {
      slug: "dev-tyler",
    });
    expect(child.parent_config_id).toBe("config_01J");
    expect(calls[0]?.url).toBe(
      "https://host.test:8787/api/v1/configs/config_01J/branch",
    );
    expect(calls[0]?.body).toBe('{"slug":"dev-tyler"}');
  });

  it("escapes config and key names in every path", async () => {
    const { client, calls } = jsonClient((url, init) =>
      init?.method === "DELETE"
        ? new Response(null, { status: 204 })
        : url.endsWith("/versions")
          ? ok({ versions: [] })
          : ok({ keys: [] }),
    );

    await client.listConfigKeys("config:one");
    await client.deleteConfigSecret("config:one", "ODD/KEY");
    await client.listConfigSecretVersions("config:one", "ODD/KEY");

    expect(calls[0]?.url).toBe(
      "https://host.test:8787/api/v1/configs/config%3Aone/secrets",
    );
    expect(calls[1]?.url).toBe(
      "https://host.test:8787/api/v1/configs/config%3Aone/secrets/ODD%2FKEY",
    );
    expect(calls[2]?.url).toBe(
      "https://host.test:8787/api/v1/configs/config%3Aone/secrets/ODD%2FKEY/versions",
    );
  });

  it("rejects responses that carry a value-shaped field", async () => {
    const withValue = jsonClient(() =>
      ok({ keys: [{ ...keyMeta, value: "must-not-appear" }] }),
    );
    await expect(
      withValue.client.listConfigKeys("config_01J"),
    ).rejects.toThrow();

    const withToken = jsonClient(() =>
      ok({ configs: [{ ...config, access_token: "at_live" }] }),
    );
    await expect(
      withToken.client.listSecretConfigs("project_01J"),
    ).rejects.toThrow();

    const rollbackLeak = jsonClient(() =>
      ok({ key_name: "K", version: 2, plaintext: "nope" }),
    );
    await expect(
      rollbackLeak.client.rollbackConfigSecret("config_01J", "K", 1),
    ).rejects.toThrow();
  });
});
