import { type BoundaryValue, overlapCast } from "@opensesame/os-domain";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  AccessError,
  approveRelayRequest,
  claimDelegation,
  denyRelayRequest,
  getTask,
  listDelegations,
  listMyOffers,
  listRelayRequests,
  listTasks,
  mintOffer,
  narrowDelegation,
  revokeDelegation,
  revokeOffer,
  terminateTask,
} from "./access.js";

const hostFetch = vi.hoisted(() => vi.fn());

import { identitySeams } from "./identity.js";
Object.assign(identitySeams, {
  hostFetch,
  hostBase: () => "http://127.0.0.1:8787",
});

type LastCall = { url: string; init: RequestInit };

function jsonResponse(body: BoundaryValue, status = 200): Response {
  if (status === 204) return new Response(null, { status });
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function lastCall(): LastCall {
  const call = hostFetch.mock.calls.at(-1);
  if (!call) throw new Error("hostFetch was not called");
  return { url: String(call[0]), init: call[1] ? overlapCast(call[1]) : {} };
}

/** Await a call expected to fail, returning the thrown error as an Error. */
async function failureOf(
  promise: Promise<BoundaryValue> | Promise<void>,
): Promise<Error> {
  try {
    await promise;
  } catch (caught) {
    return caught instanceof Error ? caught : new Error(String(caught));
  }
  throw new Error("expected the call to fail");
}

describe("access client", () => {
  beforeEach(() => {
    hostFetch.mockReset();
  });

  it("lists pending relay requests with camel-case fields", async () => {
    hostFetch.mockResolvedValue(
      jsonResponse({
        requests: [
          {
            id: "rreq_1",
            delegation_id: "dlg_1",
            connection_id: "conn_1",
            operation: "repository.read",
            resource: "repo:acme/catalog",
            parameters: { path: "/README.md" },
            request_digest: "sha256:abc",
            state: "pending_approval",
          },
        ],
      }),
    );
    const requests = await listRelayRequests();
    expect(lastCall().url).toBe("/api/v1/relay/requests/pending");
    expect(requests).toEqual([
      {
        id: "rreq_1",
        delegationId: "dlg_1",
        connectionId: "conn_1",
        operation: "repository.read",
        resource: "repo:acme/catalog",
        parameters: { path: "/README.md" },
        requestDigest: "sha256:abc",
        state: "pending_approval",
      },
    ]);
  });

  it("approves and denies with the digest echoed in the body", async () => {
    hostFetch.mockResolvedValue(
      jsonResponse({ id: "rreq_1", state: "approved" }),
    );
    const approved = await approveRelayRequest("rreq_1", "sha256:abc");
    expect(approved).toEqual({ id: "rreq_1", state: "approved" });
    expect(lastCall().url).toBe("/api/v1/relay/requests/rreq_1/approve");
    expect(String(lastCall().init.body)).toBe(
      JSON.stringify({ request_digest: "sha256:abc" }),
    );

    hostFetch.mockResolvedValue(
      jsonResponse({ id: "rreq_2", state: "denied" }),
    );
    const denied = await denyRelayRequest("rreq_2", "sha256:def");
    expect(denied.state).toBe("denied");
    expect(lastCall().url).toBe("/api/v1/relay/requests/rreq_2/deny");
  });

  it("maps a 404 on decide to already-decided-or-lapsed wording", async () => {
    hostFetch.mockResolvedValue(jsonResponse({ error: "not_found" }, 404));
    const approved = await failureOf(
      approveRelayRequest("rreq_1", "sha256:abc"),
    );
    expect(approved).toBeInstanceOf(AccessError);
    expect(approved.message).toMatch(
      /Already decided or lapsed — someone else got there/,
    );

    hostFetch.mockResolvedValue(jsonResponse({ error: "not_found" }, 404));
    const denied = await failureOf(denyRelayRequest("rreq_1", "sha256:abc"));
    expect(denied.message).toMatch(/Already decided or lapsed/);
  });

  it("lists tasks and reads one task with its capability sets", async () => {
    hostFetch.mockResolvedValue(
      jsonResponse({
        tasks: [
          {
            task_run_id: "task_1",
            state_version: 7,
            status: "active",
            principal_id: "prn_op",
          },
        ],
      }),
    );
    const tasks = await listTasks();
    expect(tasks).toEqual([
      {
        taskRunId: "task_1",
        stateVersion: 7,
        status: "active",
        principalId: "prn_op",
      },
    ]);

    hostFetch.mockResolvedValue(
      jsonResponse({
        task_run_id: "task_1",
        state_version: 7,
        status: "active",
        capability_ceiling: { capabilities: [] },
        current_capabilities: [],
      }),
    );
    const detail = await getTask("task_1");
    expect(lastCall().url).toBe("/api/v1/tasks/task_1");
    expect(detail.capabilityCeiling).toEqual({ capabilities: [] });
    expect(detail.currentCapabilities).toEqual([]);
  });

  it("terminates with the expected state version only when given", async () => {
    hostFetch.mockResolvedValue(
      jsonResponse({
        task_run_id: "task_1",
        state_version: 8,
        status: "cancelled",
      }),
    );
    await terminateTask("task_1", 7);
    expect(lastCall().url).toBe("/api/v1/tasks/task_1/terminate");
    expect(String(lastCall().init.body)).toBe(
      JSON.stringify({ expected_state_version: 7 }),
    );

    hostFetch.mockResolvedValue(
      jsonResponse({
        task_run_id: "task_2",
        state_version: 2,
        status: "cancelled",
      }),
    );
    await terminateTask("task_2");
    expect(String(lastCall().init.body)).toBe("{}");
  });

  it("lists my delegation offers with their items", async () => {
    hostFetch.mockResolvedValue(
      jsonResponse({
        offers: [
          {
            id: "dlgo_1",
            state: "pending",
            manifest_digest: "sha256:manifest",
            expires_at: "2026-08-30T00:00:00Z",
            items: [
              {
                id: "dlgi_1",
                connection_id: "conn_1",
                provider_id: "github",
                display_name: "GitHub PAT",
                actions: ["repository.read"],
                resources: ["*"],
                expires_in_seconds: 3600,
                execution_mode: "relay",
                required: true,
                dependencies: [],
              },
            ],
          },
        ],
      }),
    );
    const offers = await listMyOffers();
    expect(lastCall().url).toBe("/api/v1/delegations/offers");
    expect(offers).toHaveLength(1);
    expect(offers[0]).toMatchObject({
      id: "dlgo_1",
      state: "pending",
      manifestDigest: "sha256:manifest",
    });
    expect(offers[0]?.items[0]).toEqual({
      id: "dlgi_1",
      connectionId: "conn_1",
      providerId: "github",
      displayName: "GitHub PAT",
      actions: ["repository.read"],
      resources: ["*"],
      expiresInSeconds: 3600,
      executionMode: "relay",
      required: true,
      dependencies: [],
    });
  });

  it("lists delegations with camel-case fields", async () => {
    hostFetch.mockResolvedValue(
      jsonResponse({
        delegations: [
          {
            id: "dlg_1",
            offer_id: "dlgo_1",
            connection_id: "conn_1",
            claimant_subject: "agt_bot",
            grant_id: "grt_1",
            execution_mode: "broker",
            actions: ["repository.read"],
            resources: ["repo:acme/*"],
            expires_at: "2026-08-30T01:00:00Z",
            revoked_at: "2026-08-29T12:00:00Z",
          },
        ],
      }),
    );
    const delegations = await listDelegations();
    expect(lastCall().url).toBe("/api/v1/delegations");
    expect(delegations).toEqual([
      {
        id: "dlg_1",
        offerId: "dlgo_1",
        connectionId: "conn_1",
        claimantSubject: "agt_bot",
        grantId: "grt_1",
        executionMode: "broker",
        actions: ["repository.read"],
        resources: ["repo:acme/*"],
        expiresAt: "2026-08-30T01:00:00Z",
        revokedAt: "2026-08-29T12:00:00Z",
      },
    ]);
  });

  it("revokes a delegation with a bare DELETE", async () => {
    hostFetch.mockResolvedValue(jsonResponse(null, 204));
    await revokeDelegation("dlg_1");
    expect(lastCall().url).toBe("/api/v1/delegations/dlg_1");
    expect(lastCall().init.method).toBe("DELETE");
  });

  it("narrows a delegation, sending only the fields given", async () => {
    hostFetch.mockResolvedValue(
      jsonResponse({
        delegation: {
          id: "dlg_1",
          offer_id: "dlgo_1",
          connection_id: "conn_1",
          claimant_subject: "agt_bot",
          grant_id: "grt_1",
          execution_mode: "broker",
          actions: ["repository.read"],
          resources: ["*"],
          expires_at: "2026-08-29T13:00:00Z",
          revoked_at: null,
        },
      }),
    );
    const narrowed = await narrowDelegation("dlg_1", {
      actions: ["repository.read"],
      expiresInSeconds: 600,
    });
    expect(lastCall().url).toBe("/api/v1/delegations/dlg_1/narrow");
    expect(String(lastCall().init.body)).toBe(
      JSON.stringify({ actions: ["repository.read"], expires_in_seconds: 600 }),
    );
    expect(narrowed.actions).toEqual(["repository.read"]);
  });

  it("mints an offer and maps the one-time token and code", async () => {
    hostFetch.mockResolvedValue(
      jsonResponse(
        {
          offer: {
            id: "dlgo_1",
            state: "pending",
            manifest_digest: "sha256:manifest",
            expires_at: "2026-08-29T12:10:00Z",
            items: [
              {
                id: "dlgi_1",
                connection_id: "conn_1",
                provider_id: "github",
                display_name: "GitHub PAT",
                actions: ["repository.read"],
                resources: ["*"],
                expires_in_seconds: 3600,
                execution_mode: "relay",
                required: true,
                dependencies: [],
              },
            ],
          },
          claim_token: "osc_dlg_x.y",
          user_code: "AAAA-BBBB",
        },
        201,
      ),
    );
    const minted = await mintOffer({
      items: [
        {
          connectionId: "conn_1",
          actions: ["repository.read"],
          resources: ["*"],
          expiresInSeconds: 3600,
          executionMode: "relay",
        },
      ],
    });
    expect(lastCall().url).toBe("/api/v1/delegations");
    expect(lastCall().init.method).toBe("POST");
    expect(String(lastCall().init.body)).toBe(
      JSON.stringify({
        items: [
          {
            connection_id: "conn_1",
            actions: ["repository.read"],
            resources: ["*"],
            expires_in_seconds: 3600,
            execution_mode: "relay",
          },
        ],
      }),
    );
    expect(minted.claimToken).toBe("osc_dlg_x.y");
    expect(minted.userCode).toBe("AAAA-BBBB");
    expect(minted.offer.id).toBe("dlgo_1");
    expect(minted.offer.items).toHaveLength(1);
  });

  it("omits unset offer item fields so server defaults apply", async () => {
    hostFetch.mockResolvedValue(
      jsonResponse(
        {
          offer: {
            id: "dlgo_2",
            state: "pending",
            manifest_digest: "sha256:m2",
            expires_at: "2026-08-29T12:10:00Z",
            items: [],
          },
          claim_token: "osc_dlg_a.b",
          user_code: "CCCC-DDDD",
        },
        201,
      ),
    );
    await mintOffer({ items: [{ connectionId: "conn_1" }] });
    expect(String(lastCall().init.body)).toBe(
      JSON.stringify({ items: [{ connection_id: "conn_1" }] }),
    );
  });

  it("revokes an offer with a bare DELETE", async () => {
    hostFetch.mockResolvedValue(jsonResponse(null, 204));
    await revokeOffer("dlgo_1");
    expect(lastCall().url).toBe("/api/v1/delegations/offers/dlgo_1");
    expect(lastCall().init.method).toBe("DELETE");
  });

  it("maps a 401 on the delegation surfaces to sign-in wording", async () => {
    hostFetch.mockResolvedValue(jsonResponse({ error: "unauthorized" }, 401));
    const listed = await failureOf(listDelegations());
    expect(listed).toBeInstanceOf(AccessError);
    expect(listed.message).toMatch(
      /The Host refused this user session. Reconnect to Identity and try again./,
    );

    hostFetch.mockResolvedValue(jsonResponse({ error: "unauthorized" }, 401));
    const minted = await failureOf(mintOffer({ items: [] }));
    expect(minted.message).toMatch(/Reconnect to Identity and try again/);
  });

  it("maps a 404 on revoke to plain words", async () => {
    hostFetch.mockResolvedValue(jsonResponse({ error: "not_found" }, 404));
    const revoked = await failureOf(revokeDelegation("dlg_gone"));
    expect(revoked).toBeInstanceOf(AccessError);
    if (revoked instanceof AccessError) {
      expect(revoked.status).toBe(404);
    }
    expect(revoked.message).toMatch(
      /The Host does not know that id — it may already be gone./,
    );

    hostFetch.mockResolvedValue(jsonResponse({ error: "not_found" }, 404));
    const offerRevoked = await failureOf(revokeOffer("dlgo_gone"));
    expect(offerRevoked.message).toMatch(/may already be gone/);
  });

  it("maps network failures on the delegation surfaces to unreachable", async () => {
    hostFetch.mockRejectedValue(new TypeError("fetch failed"));
    const error = await failureOf(listMyOffers());
    expect(error).toBeInstanceOf(AccessError);
    if (error instanceof AccessError) {
      expect(error.code).toBe("unreachable");
    }
    expect(error.message).toMatch(
      /Host API unreachable at http:\/\/127\.0\.0\.1:8787/,
    );
  });

  it("claims a delegation offer with token, code, and accepted items", async () => {
    hostFetch.mockResolvedValue(
      jsonResponse({
        delegations: [
          {
            id: "dlg_1",
            offer_id: "dlgo_1",
            connection_id: "conn_1",
            claimant_subject: "prn_op",
            grant_id: "grt_1",
            execution_mode: "relay",
            actions: ["repository.read"],
            resources: ["*"],
            expires_at: "2026-08-30T01:00:00Z",
            revoked_at: null,
          },
        ],
      }),
    );
    const delegations = await claimDelegation({
      claimToken: "osc_dlg_x.y",
      userCode: "AAAA-BBBB",
      acceptedItemIds: ["dlgi_1"],
    });
    const { url, init } = lastCall();
    expect(url).toBe("/api/v1/delegations/claim");
    expect(String(init.body)).toBe(
      JSON.stringify({
        claim_token: "osc_dlg_x.y",
        user_code: "AAAA-BBBB",
        accepted_item_ids: ["dlgi_1"],
      }),
    );
    expect(delegations).toHaveLength(1);
    expect(delegations[0]).toMatchObject({
      id: "dlg_1",
      offerId: "dlgo_1",
      claimantSubject: "prn_op",
      revokedAt: null,
    });
  });

  it("maps network failures to an unreachable-Host error", async () => {
    hostFetch.mockRejectedValue(new TypeError("fetch failed"));
    const error = await failureOf(listTasks());
    expect(error).toBeInstanceOf(AccessError);
    if (error instanceof AccessError) {
      expect(error.code).toBe("unreachable");
    }
    expect(error.message).toMatch(
      /Host API unreachable at http:\/\/127\.0\.0\.1:8787/,
    );
  });

  it("passes Host error statuses through in plain words", async () => {
    hostFetch.mockResolvedValue(
      jsonResponse({ error: "not_found", detail: "task" }, 404),
    );
    const error = await failureOf(getTask("task_nope"));
    expect(error).toBeInstanceOf(AccessError);
    if (error instanceof AccessError) {
      expect(error.status).toBe(404);
    }
  });
});
