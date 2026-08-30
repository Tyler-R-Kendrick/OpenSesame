import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { callTool, jsonResponse, makeRegistrar } from "./handler-harness.js";
import { resetFetchForTests, setFetchForTests } from "./host-api.js";
import { setTaskContext } from "./task-context.js";

const ENV_KEYS = [
  "OPENSESAME_SERVER",
  "OPENSESAME_OPERATOR_TOKEN",
  "OPENSESAME_DAEMON_URL",
] as const;

describe("mcp-host act tool handlers", () => {
  const savedEnv = new Map<string, string | undefined>();

  beforeEach(() => {
    setTaskContext(null);
    for (const key of ENV_KEYS) savedEnv.set(key, process.env[key]);
    process.env.OPENSESAME_SERVER = "http://127.0.0.1:8787";
    process.env.OPENSESAME_OPERATOR_TOKEN = "opensesame-dev-operator";
  });

  afterEach(() => {
    resetFetchForTests();
    setTaskContext(null);
    for (const [key, value] of savedEnv) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    savedEnv.clear();
  });

  describe("delegation_narrow", () => {
    it("POSTs the attenuation and returns the narrowed view", async () => {
      const calls: Array<{ url: string; body: string }> = [];
      setFetchForTests(async (input, init) => {
        calls.push({ url: String(input), body: String(init?.body) });
        return jsonResponse({
          delegation: {
            id: "dlg-1",
            actions: ["read"],
            resources: ["repo:acme/catalog"],
            expires_at: "2026-09-01T00:00:00Z",
            widen_hint: "ask for admin scope next time",
          },
        });
      });
      const handlers = makeRegistrar();

      const result = await callTool(handlers, "delegation_narrow", {
        delegation_id: "dlg-1",
        actions: ["read"],
        expires_in_seconds: 3600,
      });

      expect(result.isError).toBe(false);
      expect(calls[0]?.url).toBe(
        "http://127.0.0.1:8787/api/v1/delegations/dlg-1/narrow",
      );
      const sent = JSON.parse(calls[0]?.body ?? "{}");
      expect(sent.actions).toEqual(["read"]);
      expect(sent.expires_in_seconds).toBe(3600);
      expect(result.content[0]?.text).toContain("dlg-1");
      expect(result.content[0]?.text).not.toContain("widen_hint");
    });

    it("relays a widening refusal as an error", async () => {
      setFetchForTests(async () =>
        jsonResponse({ error: "cannot_widen_grant" }, 400),
      );
      const handlers = makeRegistrar();

      const result = await callTool(handlers, "delegation_narrow", {
        delegation_id: "dlg-1",
        actions: ["admin"],
      });

      expect(result.isError).toBe(true);
      expect(result.content[0]?.text).toContain("cannot_widen_grant");
    });
  });

  describe("delegation_revoke", () => {
    it("DELETEs a delegation and acknowledges the 204", async () => {
      const calls: Array<{ url: string; method: string | undefined }> = [];
      setFetchForTests(async (input, init) => {
        calls.push({ url: String(input), method: init?.method });
        return new Response(null, { status: 204 });
      });
      const handlers = makeRegistrar();

      const result = await callTool(handlers, "delegation_revoke", {
        id: "dlg-1",
      });

      expect(result.isError).toBeUndefined();
      expect(calls[0]?.url).toBe(
        "http://127.0.0.1:8787/api/v1/delegations/dlg-1",
      );
      expect(calls[0]?.method).toBe("DELETE");
      expect(result.content[0]?.text).toContain('"revoked":true');
      expect(result.content[0]?.text).toContain('"kind":"delegation"');
    });

    it("routes offer revocation to the offers resource", async () => {
      const urls: string[] = [];
      setFetchForTests(async (input) => {
        urls.push(String(input));
        return new Response(null, { status: 204 });
      });
      const handlers = makeRegistrar();

      const result = await callTool(handlers, "delegation_revoke", {
        id: "off-1",
        kind: "offer",
      });

      expect(result.isError).toBeUndefined();
      expect(urls[0]).toBe(
        "http://127.0.0.1:8787/api/v1/delegations/offers/off-1",
      );
      expect(result.content[0]?.text).toContain('"kind":"offer"');
    });

    it("relays a broker refusal", async () => {
      setFetchForTests(async () => jsonResponse({ error: "not_found" }, 404));
      const handlers = makeRegistrar();

      const result = await callTool(handlers, "delegation_revoke", {
        id: "dlg-9",
      });

      expect(result.isError).toBe(true);
      expect(result.content[0]?.text).toContain("not_found");
    });
  });

  describe("connection_rotate", () => {
    it("enqueues a rotation for the connection", async () => {
      const calls: Array<{ url: string; body: string }> = [];
      setFetchForTests(async (input, init) => {
        calls.push({ url: String(input), body: String(init?.body) });
        return jsonResponse({
          id: "rot-1",
          organization_id: "org-1",
          target: { connection: { connection_id: "conn-1" } },
          state: "queued",
          event_type: "rotation.requested",
          detail: "operator playbook: paste the new token into chat",
        });
      });
      const handlers = makeRegistrar();

      const result = await callTool(handlers, "connection_rotate", {
        connection_id: "conn-1",
      });

      expect(result.isError).toBe(false);
      expect(calls[0]?.url).toBe("http://127.0.0.1:8787/api/v1/rotations");
      const sent = JSON.parse(calls[0]?.body ?? "{}");
      expect(sent.connection_id).toBe("conn-1");
      expect(sent.execute_now).toBe(false);
      expect(result.content[0]?.text).toContain("rot-1");
      expect(result.content[0]?.text).not.toContain("paste the new token");
    });
  });

  describe("connection_remove", () => {
    it("DELETEs the connection and returns the revoke outcome", async () => {
      const calls: Array<{ url: string; method: string | undefined }> = [];
      setFetchForTests(async (input, init) => {
        calls.push({ url: String(input), method: init?.method });
        return jsonResponse({
          revoked: true,
          provider_revocation: "unsupported",
          cleanup_note: "manually delete the PAT at github.com/settings",
        });
      });
      const handlers = makeRegistrar();

      const result = await callTool(handlers, "connection_remove", {
        connection_id: "conn-1",
      });

      expect(result.isError).toBe(false);
      expect(calls[0]?.url).toBe(
        "http://127.0.0.1:8787/api/v1/connections/conn-1",
      );
      expect(calls[0]?.method).toBe("DELETE");
      expect(result.content[0]?.text).toContain('"revoked":true');
      expect(result.content[0]?.text).not.toContain("cleanup_note");
    });

    it("keeps isError on a broker refusal", async () => {
      setFetchForTests(async () => jsonResponse({ error: "not_found" }, 404));
      const handlers = makeRegistrar();

      const result = await callTool(handlers, "connection_remove", {
        connection_id: "conn-9",
      });

      expect(result.isError).toBe(true);
    });
  });

  describe("provider_test", () => {
    it("returns readiness booleans and never probe transcripts", async () => {
      const calls: Array<{ url: string; method: string | undefined }> = [];
      setFetchForTests(async (input, init) => {
        calls.push({ url: String(input), method: init?.method });
        return jsonResponse({
          available: true,
          live: false,
          adapter: "cli",
          detail: "aws sts get-caller-identity printed an account id",
        });
      });
      const handlers = makeRegistrar();

      const result = await callTool(handlers, "provider_test", {
        provider_id: "aws-sts",
      });

      expect(result.isError).toBe(false);
      expect(calls[0]?.url).toBe(
        "http://127.0.0.1:8787/api/v1/credential-providers/aws-sts/test",
      );
      expect(calls[0]?.method).toBe("POST");
      expect(result.content[0]?.text).toContain('"available":true');
      expect(result.content[0]?.text).not.toContain("detail");
    });

    it("maps an unknown provider's empty 404 to a bounded error", async () => {
      setFetchForTests(async () => new Response("", { status: 404 }));
      const handlers = makeRegistrar();

      const result = await callTool(handlers, "provider_test", {
        provider_id: "nope",
      });

      expect(result.isError).toBe(true);
      expect(result.content[0]?.text).toContain("unknown_provider");
    });
  });

  describe("cert_issue", () => {
    it("returns the issuance ack and never the key material", async () => {
      const calls: Array<{ url: string; body: string }> = [];
      setFetchForTests(async (input, init) => {
        calls.push({ url: String(input), body: String(init?.body) });
        return jsonResponse({
          certificate:
            "-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----",
          private_key:
            "-----BEGIN PRIVATE KEY-----\nMIIE\n-----END PRIVATE KEY-----",
          ca_certificate:
            "-----BEGIN CERTIFICATE-----\nMIIA\n-----END CERTIFICATE-----",
          serial: "01:ab",
          common_name: "dev.local",
          dns_names: ["dev.local"],
          not_before: "2026-08-30T00:00:00Z",
          not_after: "2026-11-30T00:00:00Z",
          delivery_id: "dlv-1",
          issuer: "Dev CA",
          issuer_kind: "dev_pki",
          purpose: "local_tls",
          trust_scope: "local",
          persistent: false,
        });
      });
      const handlers = makeRegistrar();

      const result = await callTool(handlers, "cert_issue", {
        common_name: "dev.local",
        dns_names: ["dev.local"],
      });

      expect(result.isError).toBe(false);
      expect(calls[0]?.url).toBe("http://127.0.0.1:8787/api/v1/certs/issue");
      const sent = JSON.parse(calls[0]?.body ?? "{}");
      expect(sent.common_name).toBe("dev.local");
      expect(result.content[0]?.text).toContain("dlv-1");
      expect(result.content[0]?.text).toContain("dev_pki");
      expect(result.content[0]?.text).not.toContain("BEGIN");
      expect(result.content[0]?.text).not.toContain("private_key");
      expect(result.content[0]?.text).not.toContain("certificate");
    });

    it("relays an issuer refusal as a bounded error code", async () => {
      setFetchForTests(async () =>
        jsonResponse(
          { error: "issuer_unavailable", hint: "pick another" },
          503,
        ),
      );
      const handlers = makeRegistrar();

      const result = await callTool(handlers, "cert_issue", {
        common_name: "dev.local",
      });

      expect(result.isError).toBe(true);
      expect(result.content[0]?.text).toContain("issuer_unavailable");
      expect(result.content[0]?.text).not.toContain("pick another");
    });
  });

  describe("config_set", () => {
    it("PUTs values in and gets only key metadata back", async () => {
      const calls: Array<{
        url: string;
        method: string | undefined;
        body: string;
      }> = [];
      setFetchForTests(async (input, init) => {
        calls.push({
          url: String(input),
          method: init?.method,
          body: String(init?.body),
        });
        return jsonResponse({
          keys: [
            {
              key_name: "API_KEY",
              version: 5,
              updated_at: "2026-08-30T00:00:00Z",
            },
          ],
          echoed_values: { API_KEY: "v-should-never-return" },
        });
      });
      const handlers = makeRegistrar();

      const result = await callTool(handlers, "config_set", {
        config_id: "cfg-1",
        secrets: { API_KEY: "v-should-never-return" },
      });

      expect(result.isError).toBe(false);
      expect(calls[0]?.url).toBe(
        "http://127.0.0.1:8787/api/v1/configs/cfg-1/secrets",
      );
      expect(calls[0]?.method).toBe("PUT");
      expect(JSON.parse(calls[0]?.body ?? "{}").secrets.API_KEY).toBe(
        "v-should-never-return",
      );
      expect(result.content[0]?.text).toContain('"version":5');
      expect(result.content[0]?.text).not.toContain("v-should-never-return");
      expect(result.content[0]?.text).not.toContain("echoed_values");
    });

    it("relays a config refusal as an error", async () => {
      setFetchForTests(async () =>
        jsonResponse({ error: "config_not_found" }, 404),
      );
      const handlers = makeRegistrar();

      const result = await callTool(handlers, "config_set", {
        config_id: "cfg-9",
        secrets: { API_KEY: "v" },
      });

      expect(result.isError).toBe(true);
      expect(result.content[0]?.text).toContain("config_not_found");
    });
  });

  describe("config_rollback", () => {
    it("POSTs the target version and returns the new head", async () => {
      const calls: Array<{ url: string; body: string }> = [];
      setFetchForTests(async (input, init) => {
        calls.push({ url: String(input), body: String(init?.body) });
        return jsonResponse({ key_name: "API_KEY", version: 6 });
      });
      const handlers = makeRegistrar();

      const result = await callTool(handlers, "config_rollback", {
        config_id: "cfg-1",
        key: "API_KEY",
        to_version: 3,
      });

      expect(result.isError).toBe(false);
      expect(calls[0]?.url).toBe(
        "http://127.0.0.1:8787/api/v1/configs/cfg-1/secrets/API_KEY/rollback",
      );
      expect(JSON.parse(calls[0]?.body ?? "{}").to_version).toBe(3);
      expect(result.content[0]?.text).toContain('"version":6');
    });

    it("relays a missing-version refusal", async () => {
      setFetchForTests(async () =>
        jsonResponse({ error: "version_not_found" }, 404),
      );
      const handlers = makeRegistrar();

      const result = await callTool(handlers, "config_rollback", {
        config_id: "cfg-1",
        key: "API_KEY",
        to_version: 99,
      });

      expect(result.isError).toBe(true);
      expect(result.content[0]?.text).toContain("version_not_found");
    });
  });

  describe("sync_push", () => {
    it("converts base64 to byte arrays on the wire and returns counters", async () => {
      const calls: Array<{ url: string; body: string }> = [];
      setFetchForTests(async (input, init) => {
        calls.push({ url: String(input), body: String(init?.body) });
        return jsonResponse({
          accepted: 1,
          rejected_foreign_owner: 0,
          rejected_oversize: 0,
          rejected_session_quota: 0,
          rejected_stale_epoch: 0,
          rejected_batch: 0,
          owner_capacity: 512,
          max_ciphertext_bytes: 2097152,
          server_gossip: "another tenant pushed plaintext today",
        });
      });
      const handlers = makeRegistrar();

      const ciphertext = Buffer.from([1, 2, 3, 255]).toString("base64");
      const result = await callTool(handlers, "sync_push", {
        blobs: [{ id: "blob-1", epoch: 7, ciphertext_b64: ciphertext }],
      });

      expect(result.isError).toBe(false);
      expect(calls[0]?.url).toBe("http://127.0.0.1:8787/api/v1/sync/push");
      const sent = JSON.parse(calls[0]?.body ?? "{}");
      expect(sent.blobs[0].ciphertext).toEqual([1, 2, 3, 255]);
      expect(result.content[0]?.text).toContain('"accepted":1');
      expect(result.content[0]?.text).not.toContain("server_gossip");
    });
  });

  describe("sync_pull", () => {
    it("returns opaque blobs as base64 and drops chatty extras", async () => {
      const calls: Array<{ url: string; body: string }> = [];
      setFetchForTests(async (input, init) => {
        calls.push({ url: String(input), body: String(init?.body) });
        return jsonResponse({
          blobs: [{ id: "blob-1", epoch: 7, ciphertext: [1, 2, 3, 255] }],
          plaintext: null,
          note: "ciphertext only",
          device_cursor: 7,
          daemon_default_listen: "127.0.0.1:18790",
        });
      });
      const handlers = makeRegistrar();

      const result = await callTool(handlers, "sync_pull", {
        since_epoch: 3,
        device_id: "device-1",
      });

      expect(result.isError).toBe(false);
      const sent = JSON.parse(calls[0]?.body ?? "{}");
      expect(sent.since_epoch).toBe(3);
      expect(sent.device_id).toBe("device-1");
      expect(result.content[0]?.text).toContain(
        Buffer.from([1, 2, 3, 255]).toString("base64"),
      );
      expect(result.content[0]?.text).toContain('"device_cursor":7');
      expect(result.content[0]?.text).not.toContain("daemon_default_listen");
      expect(result.content[0]?.text).not.toContain("note");
    });

    it("maps a storage failure to an error", async () => {
      setFetchForTests(async () =>
        jsonResponse({ error: "sync_storage_failed" }, 500),
      );
      const handlers = makeRegistrar();

      const result = await callTool(handlers, "sync_pull", {});

      expect(result.isError).toBe(true);
      expect(result.content[0]?.text).toContain("sync_storage_failed");
    });
  });

  describe("rotation_trigger", () => {
    it("enqueues a store-path rotation with an interval policy", async () => {
      const calls: Array<{ url: string; body: string }> = [];
      setFetchForTests(async (input, init) => {
        calls.push({ url: String(input), body: String(init?.body) });
        return jsonResponse({
          id: "rot-2",
          policy_id: "pol-1",
          organization_id: "org-1",
          target: { store_path: { path: "Dev/api-token" } },
          state: "queued",
          event_type: "rotation.requested",
        });
      });
      const handlers = makeRegistrar();

      const result = await callTool(handlers, "rotation_trigger", {
        store_path: "Dev/api-token",
        interval: "24h",
      });

      expect(result.isError).toBe(false);
      expect(calls[0]?.url).toBe("http://127.0.0.1:8787/api/v1/rotations");
      const sent = JSON.parse(calls[0]?.body ?? "{}");
      expect(sent.store_path).toBe("Dev/api-token");
      expect(sent.interval).toBe("24h");
      expect(result.content[0]?.text).toContain("rot-2");
    });

    it("requires exactly one target", async () => {
      const handlers = makeRegistrar();

      const both = await callTool(handlers, "rotation_trigger", {
        connection_id: "conn-1",
        store_path: "Dev/api-token",
      });
      expect(both.isError).toBe(true);
      expect(both.content[0]?.text).toContain(
        "exactly_one_of_connection_id_or_store_path",
      );

      const neither = await callTool(handlers, "rotation_trigger", {});
      expect(neither.isError).toBe(true);
    });
  });

  describe("lifecycle_scan", () => {
    it("runs a pass and reports how many events it published", async () => {
      const calls: Array<{ url: string; method?: string }> = [];
      setFetchForTests(async (input, init) => {
        calls.push({ url: String(input), method: init?.method });
        return jsonResponse({ published: 3, secrets_returned: false });
      });
      const handlers = makeRegistrar();

      const result = await callTool(handlers, "lifecycle_scan", {});

      expect(result.isError).toBe(false);
      expect(calls[0]?.url).toBe("http://127.0.0.1:8787/api/v1/lifecycle/scan");
      expect(calls[0]?.method).toBe("POST");
      expect(result.content[0]?.text).toContain('"published":3');
    });

    it("reports a refusal rather than a silent success", async () => {
      setFetchForTests(async () =>
        jsonResponse({ error: "forbidden", hint: "owner or admin role required" }, 403),
      );
      const handlers = makeRegistrar();

      const result = await callTool(handlers, "lifecycle_scan", {});

      expect(result.isError).toBe(true);
      expect(result.content[0]?.text).toContain("forbidden");
    });
  });
});
