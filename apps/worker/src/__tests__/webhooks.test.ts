import { MemoryRepositories } from "@opensesame/database";
import type { JsonObject, WebhookEndpoint } from "@opensesame/os-domain";
import { generateWebhookSecret, verifyWebhook } from "@opensesame/webhooks";
import { describe, expect, it } from "vitest";
import {
  MAX_DELIVERY_ATTEMPTS,
  deliverWebhooks,
  fanOutWebhooks,
  nextAttemptDelayMs,
} from "../webhooks.js";

const NOW = new Date("2026-08-24T12:00:00.000Z");
const APPROVER = "prn_approver";

function endpoint(overrides: Partial<WebhookEndpoint> = {}): WebhookEndpoint {
  return {
    id: `whep_${Math.random().toString(36).slice(2)}`,
    principalId: APPROVER,
    url: "https://hooks.example.test/inbox",
    secret: generateWebhookSecret(),
    createdAt: NOW,
    ...overrides,
  };
}

function inboxEvent(payload: JsonObject = {}) {
  return {
    id: "obx_1",
    aggregateType: "authorization_request",
    aggregateId: "areq_1",
    eventType: "authority.invocation.requested",
    payload: {
      principalId: APPROVER,
      authReqId: "areq_1",
      requestDigest: "sha256:abc",
      ...payload,
    },
    createdAt: NOW,
    availableAt: NOW,
    attempts: 0,
  };
}

type FetchArgs = { url: string; init: RequestInit };

function fetchRecorder(status = 200) {
  const calls: FetchArgs[] = [];
  // The dispatcher calls fetch with (url, init) only.
  // SAFETY: this stub implements exactly that call shape, checked by the contract tests below.
  const impl = (async (url: URL | RequestInfo, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return new Response("{}", { status });
  }) as typeof fetch;
  return { calls, impl };
}

describe("webhook dispatch", () => {
  it("contract: an inbox event fans out to every registered endpoint and delivers signed", async () => {
    const repos = new MemoryRepositories();
    const first = await repos.webhookEndpoints.create(endpoint());
    const second = await repos.webhookEndpoints.create(endpoint());
    const deps = { repos, clock: () => NOW };

    const enqueued = await fanOutWebhooks(deps, inboxEvent());
    expect(enqueued).toBe(2);

    const { calls, impl } = fetchRecorder();
    const result = await deliverWebhooks({ ...deps, fetchImpl: impl });
    expect(result).toEqual({ delivered: 2, failed: 0, dead: 0 });
    expect(calls).toHaveLength(2);

    // Each delivery verifies under its endpoint's own secret — the receiver
    // side of the Standard Webhooks contract, checked here so signing and
    // verification cannot drift apart.
    for (const [index, secret] of [first.secret, second.secret].entries()) {
      const call = calls[index];
      if (!call) throw new Error("missing recorded call");
      // This reads back what the dispatcher wrote.
      // SAFETY: deliverWebhooks builds headers as a plain string record at the fetch boundary.
      const headers = call.init.headers as Record<string, string>;
      const body = String(call.init.body);
      expect(
        verifyWebhook(
          secret,
          {
            "webhook-id": headers["webhook-id"] ?? "",
            "webhook-timestamp": headers["webhook-timestamp"] ?? "",
            "webhook-signature": headers["webhook-signature"] ?? "",
          },
          body,
          NOW.getTime() / 1000,
        ),
      ).toBe(true);
      // The doorbell carries digests, not the routing key and not content.
      expect(body).toContain("requestDigest");
      expect(body).not.toContain(APPROVER);
    }
  });

  it("contract: an event for a principal with no endpoints fans out to nothing", async () => {
    const repos = new MemoryRepositories();
    expect(
      await fanOutWebhooks({ repos, clock: () => NOW }, inboxEvent()),
    ).toBe(0);
  });

  it("contract: non-inbox event types are ignored", async () => {
    const repos = new MemoryRepositories();
    await repos.webhookEndpoints.create(endpoint());
    const event = { ...inboxEvent(), eventType: "principal.created" };
    expect(await fanOutWebhooks({ repos, clock: () => NOW }, event)).toBe(0);
  });

  it("chaos: a failing receiver retries with backoff and dead-letters at the cap", async () => {
    const repos = new MemoryRepositories();
    await repos.webhookEndpoints.create(endpoint());
    const clock = { now: NOW };
    const deps = { repos, clock: () => clock.now };
    await fanOutWebhooks(deps, inboxEvent());

    const failing = fetchRecorder(503);
    for (let attempt = 1; attempt < MAX_DELIVERY_ATTEMPTS; attempt += 1) {
      const result = await deliverWebhooks({
        ...deps,
        fetchImpl: failing.impl,
      });
      expect(result.delivered).toBe(0);
      expect(result.failed).toBe(1);
      // Jump past the scheduled retry so the next pass claims it again.
      clock.now = new Date(
        clock.now.getTime() + nextAttemptDelayMs(attempt) + 1,
      );
    }
    // The final attempt of the ladder is still made — and then the row is
    // dead: an endpoint down for the whole backoff is not coming back for
    // this event, and the inbox stays pollable regardless.
    const final = await deliverWebhooks({ ...deps, fetchImpl: failing.impl });
    expect(final).toEqual({ delivered: 0, failed: 0, dead: 1 });
    expect(failing.calls).toHaveLength(MAX_DELIVERY_ATTEMPTS);
    const after = await deliverWebhooks({ ...deps, fetchImpl: failing.impl });
    expect(after).toEqual({ delivered: 0, failed: 0, dead: 0 });
  });

  it("property: a delivery for a deleted endpoint dies instead of retrying forever", async () => {
    const repos = new MemoryRepositories();
    const created = await repos.webhookEndpoints.create(endpoint());
    const deps = { repos, clock: () => NOW };
    await fanOutWebhooks(deps, inboxEvent());
    // Memory cascade mirrors the Postgres ON DELETE CASCADE: the delivery
    // disappears with its endpoint, so nothing is even claimable.
    await repos.webhookEndpoints.deleteById(created.id);
    const { impl, calls } = fetchRecorder();
    const result = await deliverWebhooks({ ...deps, fetchImpl: impl });
    expect(calls).toHaveLength(0);
    expect(result).toEqual({ delivered: 0, failed: 0, dead: 0 });
  });
});
