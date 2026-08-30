import type { BoundaryValue } from "@opensesame/os-domain";
import { describe, expect, it } from "vitest";
import { createApiClient } from "./index.js";

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

function ok(body: BoundaryValue): Response {
  return new Response(JSON.stringify(body), { status: 200 });
}

function refused(code: string, status: number): Response {
  return new Response(JSON.stringify({ error: code }), { status });
}

describe("api-client tasks", () => {
  it("lists, reads, starts and terminates task runs", async () => {
    const { client, calls } = jsonClient(() =>
      ok({ task_run_id: "taskrun_01J", state_version: 1 }),
    );

    await client.listTasks();
    await client.getTask("taskrun/01J");
    await client.startTask({
      principal_id: "principal_01J",
      organization_id: "organization_01J",
      capabilities: [{ action: "repo.read", resource: "github" }],
      ttl_seconds: 600,
    });
    await client.terminateTask("taskrun_01J", 3);
    await client.terminateTask("taskrun_01J");

    expect(calls[0]?.url).toBe("https://host.test:8787/api/v1/tasks");
    expect(calls[0]?.method).toBe("GET");
    expect(calls[1]?.url).toBe(
      "https://host.test:8787/api/v1/tasks/taskrun%2F01J",
    );
    expect(calls[2]?.method).toBe("POST");
    expect(calls[2]?.body).toContain('"ttl_seconds":600');
    expect(calls[3]?.url).toBe(
      "https://host.test:8787/api/v1/tasks/taskrun_01J/terminate",
    );
    expect(calls[3]?.body).toBe('{"expected_state_version":3}');
    expect(calls[4]?.body).toBe("{}");
  });

  it("freezes and spends task intents by digest", async () => {
    const { client, calls } = jsonClient(() =>
      ok({ intent_id: "intent_01J", intent_digest: "digest_01J" }),
    );

    await client.createTaskIntent({
      task_run_id: "taskrun_01J",
      expected_state_version: 1,
      operation: "repo.read",
      resource: "github",
      audience: "github.com",
      arguments: {},
      idempotency_key: "idem_01J",
    });
    await client.invokeTaskIntent("digest_01J");

    expect(calls[0]?.url).toBe("https://host.test:8787/api/v1/tasks/intents");
    expect(calls[0]?.body).toContain('"idempotency_key":"idem_01J"');
    expect(calls[1]?.url).toBe("https://host.test:8787/api/v1/tasks/invoke");
    expect(calls[1]?.body).toBe('{"intent_digest":"digest_01J"}');
  });

  it("maps task refusals to op-coded errors", async () => {
    const { client } = jsonClient(() => refused("principal_mismatch", 403));
    await expect(
      client.startTask({
        principal_id: "principal_01J",
        organization_id: "organization_01J",
        capabilities: [{ action: "repo.read", resource: "github" }],
      }),
    ).rejects.toThrow("task_start_failed:403:principal_mismatch");
    await expect(client.invokeTaskIntent("digest_01J")).rejects.toThrow(
      "task_intent_invoke_failed:403:principal_mismatch",
    );
  });
});

describe("api-client receipts", () => {
  it("reads, verifies and lists keys", async () => {
    const { client, calls } = jsonClient(() => ok({ valid: true }));

    await client.getReceipt("receipt/01J");
    await client.verifyReceipt("receipt_01J");
    await client.receiptKeys();

    expect(calls[0]?.url).toBe(
      "https://host.test:8787/api/v1/receipts/receipt%2F01J",
    );
    expect(calls[1]?.url).toBe(
      "https://host.test:8787/api/v1/receipts/receipt_01J/verify",
    );
    expect(calls[1]?.method).toBe("POST");
    expect(calls[2]?.url).toBe("https://host.test:8787/api/v1/receipts/keys");
  });

  it("maps missing receipts to op-coded errors", async () => {
    const { client } = jsonClient(() => refused("not_found", 404));
    await expect(client.getReceipt("receipt_01J")).rejects.toThrow(
      "receipt_failed:404:not_found",
    );
  });
});

describe("api-client delegations", () => {
  it("lists, narrows and revokes delegations and offers", async () => {
    const { client, calls } = jsonClient(() => ok({ delegations: [] }));

    await client.listDelegations();
    await client.listOffers();
    await client.narrowDelegation("delegation_01J", {
      actions: ["repo.read"],
      expires_in_seconds: 60,
    });
    await client.revokeDelegation("delegation_01J");
    await client.revokeOffer("offer/01J");

    expect(calls[0]?.url).toBe("https://host.test:8787/api/v1/delegations");
    expect(calls[1]?.url).toBe(
      "https://host.test:8787/api/v1/delegations/offers",
    );
    expect(calls[2]?.url).toBe(
      "https://host.test:8787/api/v1/delegations/delegation_01J/narrow",
    );
    expect(calls[2]?.body).toBe(
      '{"actions":["repo.read"],"expires_in_seconds":60}',
    );
    expect(calls[3]?.method).toBe("DELETE");
    expect(calls[4]?.url).toBe(
      "https://host.test:8787/api/v1/delegations/offers/offer%2F01J",
    );
    expect(calls[4]?.method).toBe("DELETE");
  });

  it("surfaces widening refusals", async () => {
    const { client } = jsonClient(() => refused("widening_refused", 400));
    await expect(
      client.narrowDelegation("delegation_01J", { actions: ["*"] }),
    ).rejects.toThrow("delegation_narrow_failed:400:widening_refused");
  });
});

describe("api-client relay", () => {
  it("reads the pending inbox and a single request", async () => {
    const { client, calls } = jsonClient(() => ok({ requests: [] }));

    await client.listPendingRelayRequests();
    await client.getRelayRequest("relayreq/01J");

    expect(calls[0]?.url).toBe(
      "https://host.test:8787/api/v1/relay/requests/pending",
    );
    expect(calls[1]?.url).toBe(
      "https://host.test:8787/api/v1/relay/requests/relayreq%2F01J",
    );
  });

  it("maps relay refusals to op-coded errors", async () => {
    const { client } = jsonClient(() => refused("forbidden", 403));
    await expect(client.listPendingRelayRequests()).rejects.toThrow(
      "relay_requests_pending_failed:403:forbidden",
    );
  });
});

describe("api-client certs", () => {
  it("lists issued certs, issues, and fetches the CA", async () => {
    const { client, calls } = jsonClient(() => ok({ certs: [] }));

    await client.listCerts();
    await client.issueCert({
      common_name: "dev.localhost",
      dns_names: ["dev.localhost"],
      ttl_hours: 24,
    });
    await client.certCa();

    expect(calls[0]?.url).toBe("https://host.test:8787/api/v1/certs");
    expect(calls[1]?.url).toBe("https://host.test:8787/api/v1/certs/issue");
    expect(calls[1]?.body).toContain('"common_name":"dev.localhost"');
    expect(calls[2]?.url).toBe("https://host.test:8787/api/v1/certs/ca");
  });

  it("maps issue refusals to op-coded errors", async () => {
    const { client } = jsonClient(() => refused("issuer_unavailable", 503));
    await expect(client.issueCert({ common_name: "x" })).rejects.toThrow(
      "cert_issue_failed:503:issuer_unavailable",
    );
  });
});

describe("api-client rotations", () => {
  it("lists, enqueues, reads jobs and lists policies", async () => {
    const { client, calls } = jsonClient(() => ok({ rotations: [] }));

    await client.listRotations();
    await client.createRotation({
      connection_id: "connection_01J",
      execute_now: true,
    });
    await client.getRotation("rotation/01J");
    await client.rotationPolicies();

    expect(calls[0]?.url).toBe("https://host.test:8787/api/v1/rotations");
    expect(calls[1]?.body).toBe(
      '{"connection_id":"connection_01J","execute_now":true}',
    );
    expect(calls[2]?.url).toBe(
      "https://host.test:8787/api/v1/rotations/rotation%2F01J",
    );
    expect(calls[3]?.url).toBe(
      "https://host.test:8787/api/v1/rotation/policies",
    );
  });

  it("maps invalid rotation targets to op-coded errors", async () => {
    const { client } = jsonClient(() => refused("invalid_request", 400));
    await expect(client.createRotation({})).rejects.toThrow(
      "rotation_create_failed:400:invalid_request",
    );
  });
});

describe("api-client changelog and backup", () => {
  it("reads the project changelog with and without a cursor", async () => {
    const { client, calls } = jsonClient(() => ok({ events: [] }));

    await client.projectChangelog("project/01J");
    await client.projectChangelog("project_01J", { limit: 10, beforeSeq: 40 });

    expect(calls[0]?.url).toBe(
      "https://host.test:8787/api/v1/projects/project%2F01J/changelog",
    );
    expect(calls[1]?.url).toBe(
      "https://host.test:8787/api/v1/projects/project_01J/changelog?limit=10&before_seq=40",
    );
  });

  it("reads the backup target and maps refusals", async () => {
    const { client, calls } = jsonClient(() => ok({ configured: false }));
    await client.getBackupTarget();
    expect(calls[0]?.url).toBe("https://host.test:8787/api/v1/backup/target");

    const denied = jsonClient(() => refused("forbidden", 403));
    await expect(denied.client.getBackupTarget()).rejects.toThrow(
      "backup_target_failed:403:forbidden",
    );
    await expect(denied.client.projectChangelog("project_01J")).rejects.toThrow(
      "project_changelog_failed:403:forbidden",
    );
  });
});
