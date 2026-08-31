import { createHmac } from "node:crypto";
import { createRepositories } from "@opensesame/database";
import type { JsonObject, Repositories } from "@opensesame/os-domain";
import { overlapCast } from "@opensesame/os-domain";
import { describe, expect, it } from "vitest";
import type { ControlPlaneConfig } from "../config.js";
import { createControlPlane } from "../create-app.js";
import { callbackTransactionRef } from "../routes/approval-ceremony.js";
import type {
  NotificationCallbackAdapter,
  NotificationCallbackAdapters,
} from "../services/notification-callbacks.js";

/**
 * Provider callbacks (ADR 0081).
 *
 * The route is unauthenticated, so every test here is one link of the chain
 * that stands in for authentication: provenance over the raw bytes, the
 * three-part provider identity, the durable replay ledger, the binding's
 * liveness, and the assurance bar the channel can never clear.
 */

const SIGNING_SECRET = "slack-signing-secret-for-tests";

type Notifications = ControlPlaneConfig["notifications"];

function notifications(overrides: Partial<Notifications> = {}): Notifications {
  return {
    availableChannels: ["in_app", "slack"],
    // The operator has opted Slack in. Without this the policy allows no
    // direct settlement at all, which is the default and the whole point.
    directApprovalChannels: ["slack"],
    directDenialChannels: ["slack"],
    pushPublicKey: "",
    slackSigningSecret: SIGNING_SECRET,
    telegramSecretToken: "",
    allowSelfAssertedBindings: true,
    ...overrides,
  };
}

interface PlaneOptions {
  notifications?: Partial<Notifications>;
  repos?: Repositories;
  adapters?: NotificationCallbackAdapters;
  clock?: () => Date;
}

function plane(options?: PlaneOptions) {
  return createControlPlane({
    config: {
      port: 0,
      publicUrl: "http://127.0.0.1:8788",
      issuer: "http://127.0.0.1:8788",
      notifications: notifications(options?.notifications),
    },
    ...(options?.repos ? { repos: options.repos } : undefined),
    ...(options?.adapters
      ? { notificationCallbackAdapters: options.adapters }
      : undefined),
    ...(options?.clock ? { clock: options.clock } : undefined),
  });
}

type App = ReturnType<typeof createControlPlane>["app"];

async function principal(app: App) {
  const res = await app.request("/v1/principals/provisional", {
    method: "POST",
  });
  expect(res.status).toBe(201);
  return overlapCast(await res.json());
}

function authed(token: string) {
  return {
    authorization: `Bearer ${token}`,
    "content-type": "application/json",
  };
}

const TENANT = "T_ACME";
const SUBJECT = "U_ALICE";

async function bindSlack(
  app: App,
  token: string,
  subject = SUBJECT,
): Promise<string> {
  const begun = await app.request("/v1/notification-channels/bindings", {
    method: "POST",
    headers: authed(token),
    body: JSON.stringify({
      kind: "slack",
      displayLabel: "Acme workspace",
      destinationHint: `${TENANT}/${subject}`,
    }),
  });
  expect(begun.status).toBe(201);
  const { challengeId, nonce } = overlapCast(await begun.json());
  const done = await app.request(
    "/v1/notification-channels/bindings/complete",
    {
      method: "POST",
      headers: authed(token),
      body: JSON.stringify({ challengeId, nonce }),
    },
  );
  expect(done.status).toBe(201);
  return overlapCast(await done.json()).id;
}

let seq = 0;
/** A read-only ask: `low` risk, the only class an external channel may settle. */
async function ask(
  app: App,
  requesterToken: string,
  approverRef: string,
  overrides: JsonObject = {},
) {
  const res = await app.request("/v1/authorization-requests", {
    method: "POST",
    headers: {
      ...authed(requesterToken),
      "idempotency-key": `callback-${++seq}`,
    },
    body: JSON.stringify({
      approverRef,
      bindingMessage: "Read acme/catalog issues",
      authorizationDetails: [
        { type: "connection_delegation", actions: ["repository.read"] },
      ],
      ...overrides,
    }),
  });
  expect(res.status).toBe(201);
  return overlapCast(await res.json());
}

async function inboxRefOf(app: App, token: string): Promise<string> {
  const res = await app.request("/v1/authorization-requests/inbox-ref", {
    headers: authed(token),
  });
  return overlapCast(await res.json()).approverRef;
}

/** A Slack block-actions body, shaped as Slack sends it. */
interface SlackBodyInput {
  tenantId?: string;
  subjectId?: string;
  actionId?: string;
  transactionRef: string;
}

function slackBody(input: SlackBodyInput): string {
  const payload = {
    type: "block_actions",
    team: { id: input.tenantId ?? TENANT },
    user: { id: input.subjectId ?? SUBJECT },
    actions: [
      {
        action_id: input.actionId ?? "opensesame_approve",
        value: input.transactionRef,
      },
    ],
  };
  return new URLSearchParams({ payload: JSON.stringify(payload) }).toString();
}

/** Sign exactly the bytes that will be sent, the way Slack does. */
function slackHeaders(body: string, at: Date, secret = SIGNING_SECRET) {
  const timestamp = String(Math.floor(at.getTime() / 1000));
  const signature = `v0=${createHmac("sha256", secret)
    .update(`v0:${timestamp}:${body}`)
    .digest("hex")}`;
  return {
    "content-type": "application/x-www-form-urlencoded",
    "x-slack-signature": signature,
    "x-slack-request-timestamp": timestamp,
  };
}

async function post(app: App, body: string, at: Date, secret?: string) {
  return app.request("/v1/notification-callbacks/slack", {
    method: "POST",
    headers: slackHeaders(body, at, secret),
    body,
  });
}

async function statusOf(app: App, token: string, authReqId: string) {
  const res = await app.request(`/v1/authorization-requests/${authReqId}`, {
    headers: authed(token),
  });
  return overlapCast(await res.json()).status;
}

async function auditReasons(
  ctx: ReturnType<typeof createControlPlane>["ctx"],
): Promise<string[]> {
  const events = await ctx.repos.auditEvents.list({ limit: 100 });
  return events
    .filter((e) => e.eventType === "authority.callback.denied")
    .map((e) => String(overlapCast(e.metadata).reason ?? ""));
}

describe("a Slack callback that may settle", () => {
  it("contract: a signed, bound, first-seen callback settles the request", async () => {
    const { app, ctx } = plane();
    const approver = await principal(app);
    const requester = await principal(app);
    await bindSlack(app, approver.accessToken);
    const created = await ask(
      app,
      requester.accessToken,
      await inboxRefOf(app, approver.accessToken),
    );
    const body = slackBody({
      transactionRef: callbackTransactionRef(
        created.authReqId,
        "approved",
        ctx.config.claimPepper,
      ),
    });
    const res = await post(app, body, ctx.clock());
    // The ack says nothing about what happened — it is the same ack a
    // callback for a request that does not exist gets.
    expect(res.status).toBe(200);
    expect(await statusOf(app, approver.accessToken, created.authReqId)).toBe(
      "approved",
    );

    const receipt = await app.request(
      `/v1/authorization-requests/${created.authReqId}/receipt`,
      { headers: authed(approver.accessToken) },
    );
    const parsed = overlapCast(await receipt.json());
    expect(parsed.path).toBe("external_direct");
    expect(parsed.channelKind).toBe("slack");
  });

  it("adversarial: a valid signature from the wrong workspace settles nothing", async () => {
    // The cross-tenant case. Subject ids are unique within a tenant, so an
    // attacker who controls their own workspace can mint `U_ALICE` there.
    const { app, ctx } = plane();
    const approver = await principal(app);
    const requester = await principal(app);
    await bindSlack(app, approver.accessToken);
    const created = await ask(
      app,
      requester.accessToken,
      await inboxRefOf(app, approver.accessToken),
    );
    const body = slackBody({
      tenantId: "T_ATTACKER",
      transactionRef: callbackTransactionRef(
        created.authReqId,
        "approved",
        ctx.config.claimPepper,
      ),
    });
    expect((await post(app, body, ctx.clock())).status).toBe(200);
    expect(await statusOf(app, approver.accessToken, created.authReqId)).toBe(
      "pending",
    );
    expect((await auditReasons(ctx)).join(" ")).toContain("binding_not_usable");
  });

  it("adversarial: the right workspace and the wrong person settles nothing", async () => {
    const { app, ctx } = plane();
    const approver = await principal(app);
    const requester = await principal(app);
    await bindSlack(app, approver.accessToken);
    const created = await ask(
      app,
      requester.accessToken,
      await inboxRefOf(app, approver.accessToken),
    );
    const body = slackBody({
      subjectId: "U_MALLORY",
      transactionRef: callbackTransactionRef(
        created.authReqId,
        "approved",
        ctx.config.claimPepper,
      ),
    });
    expect((await post(app, body, ctx.clock())).status).toBe(200);
    expect(await statusOf(app, approver.accessToken, created.authReqId)).toBe(
      "pending",
    );
  });

  it("adversarial: a real binding belonging to somebody else settles nothing", async () => {
    // The confused deputy. Mallory's Slack account is genuinely bound — to
    // Mallory — so the callback authenticates, resolves and is unseen. What
    // refuses it is that the request is addressed to somebody else.
    const { app, ctx } = plane();
    const approver = await principal(app);
    const mallory = await principal(app);
    const requester = await principal(app);
    await bindSlack(app, approver.accessToken);
    await bindSlack(app, mallory.accessToken, "U_MALLORY");
    const created = await ask(
      app,
      requester.accessToken,
      await inboxRefOf(app, approver.accessToken),
    );
    const body = slackBody({
      subjectId: "U_MALLORY",
      transactionRef: callbackTransactionRef(
        created.authReqId,
        "approved",
        ctx.config.claimPepper,
      ),
    });
    expect((await post(app, body, ctx.clock())).status).toBe(200);
    expect(await statusOf(app, approver.accessToken, created.authReqId)).toBe(
      "pending",
    );
    expect((await auditReasons(ctx)).join(" ")).toContain("approver_mismatch");
  });

  it("adversarial: an unsigned or wrongly signed body never reaches a lookup", async () => {
    const { app, ctx } = plane();
    const approver = await principal(app);
    const requester = await principal(app);
    await bindSlack(app, approver.accessToken);
    const created = await ask(
      app,
      requester.accessToken,
      await inboxRefOf(app, approver.accessToken),
    );
    const body = slackBody({
      transactionRef: callbackTransactionRef(
        created.authReqId,
        "approved",
        ctx.config.claimPepper,
      ),
    });
    expect(
      (await post(app, body, ctx.clock(), "not-the-signing-secret")).status,
    ).toBe(200);
    expect(await statusOf(app, approver.accessToken, created.authReqId)).toBe(
      "pending",
    );
    // The audit says which check refused it — drawn from the same closed
    // vocabulary the settlement evaluator uses — while the caller gets the
    // one generic ack either way.
    expect(await auditReasons(ctx)).toContain("callback_not_authenticated");
  });

  it("adversarial: a correctly signed body from an hour ago is stale", async () => {
    const { app, ctx } = plane();
    const approver = await principal(app);
    const requester = await principal(app);
    await bindSlack(app, approver.accessToken);
    const created = await ask(
      app,
      requester.accessToken,
      await inboxRefOf(app, approver.accessToken),
    );
    const body = slackBody({
      transactionRef: callbackTransactionRef(
        created.authReqId,
        "approved",
        ctx.config.claimPepper,
      ),
    });
    const old = new Date(ctx.clock().getTime() - 3_600_000);
    expect((await post(app, body, old)).status).toBe(200);
    expect(await statusOf(app, approver.accessToken, created.authReqId)).toBe(
      "pending",
    );
    expect(await auditReasons(ctx)).toContain("callback_stale");
  });

  it("adversarial: a byte-identical replay settles nothing the second time", async () => {
    const { app, ctx } = plane();
    const approver = await principal(app);
    const requester = await principal(app);
    await bindSlack(app, approver.accessToken);
    const created = await ask(
      app,
      requester.accessToken,
      await inboxRefOf(app, approver.accessToken),
    );
    const body = slackBody({
      transactionRef: callbackTransactionRef(
        created.authReqId,
        "approved",
        ctx.config.claimPepper,
      ),
    });
    const at = ctx.clock();
    expect((await post(app, body, at)).status).toBe(200);
    expect((await post(app, body, at)).status).toBe(200);
    // The ledger stopped it, not the request's own state — the reason names
    // the replay, and it is recorded once.
    expect(await auditReasons(ctx)).toContain("callback_replayed");
  });

  it("adversarial: a revoked binding fails closed", async () => {
    const { app, ctx } = plane();
    const approver = await principal(app);
    const requester = await principal(app);
    const bindingId = await bindSlack(app, approver.accessToken);
    const created = await ask(
      app,
      requester.accessToken,
      await inboxRefOf(app, approver.accessToken),
    );
    const revoked = await app.request(
      `/v1/notification-channels/bindings/${bindingId}`,
      { method: "DELETE", headers: authed(approver.accessToken) },
    );
    expect(revoked.status).toBe(200);

    const body = slackBody({
      transactionRef: callbackTransactionRef(
        created.authReqId,
        "approved",
        ctx.config.claimPepper,
      ),
    });
    expect((await post(app, body, ctx.clock())).status).toBe(200);
    expect(await statusOf(app, approver.accessToken, created.authReqId)).toBe(
      "pending",
    );
    expect((await auditReasons(ctx)).join(" ")).toContain("binding_not_usable");
  });

  it("adversarial: a reference minted to deny cannot be presented with an approve action", async () => {
    const { app, ctx } = plane();
    const approver = await principal(app);
    const requester = await principal(app);
    await bindSlack(app, approver.accessToken);
    const created = await ask(
      app,
      requester.accessToken,
      await inboxRefOf(app, approver.accessToken),
    );
    const body = slackBody({
      actionId: "opensesame_approve",
      transactionRef: callbackTransactionRef(
        created.authReqId,
        "denied",
        ctx.config.claimPepper,
      ),
    });
    expect((await post(app, body, ctx.clock())).status).toBe(200);
    expect(await statusOf(app, approver.accessToken, created.authReqId)).toBe(
      "pending",
    );
  });

  it("adversarial: a forged transaction reference resolves to nothing", async () => {
    const { app, ctx } = plane();
    const approver = await principal(app);
    const requester = await principal(app);
    await bindSlack(app, approver.accessToken);
    const created = await ask(
      app,
      requester.accessToken,
      await inboxRefOf(app, approver.accessToken),
    );
    const real = callbackTransactionRef(
      created.authReqId,
      "approved",
      ctx.config.claimPepper,
    );
    const forged = `${real.split(".")[0]}.${"a".repeat(32)}`;
    const body = slackBody({ transactionRef: forged });
    expect((await post(app, body, ctx.clock())).status).toBe(200);
    expect(await statusOf(app, approver.accessToken, created.authReqId)).toBe(
      "pending",
    );
    expect(await auditReasons(ctx)).toContain(
      "unresolvable_transaction_reference",
    );
  });

  it("adversarial: a policy demanding phishing resistance refuses the same valid callback", async () => {
    // Nothing about the callback changed. What changed is what the request
    // asks for — and no chat app is a credential bound to an origin, so the
    // honest answer is "come to the app", not "try again".
    const { app, ctx } = plane();
    const approver = await principal(app);
    const requester = await principal(app);
    await bindSlack(app, approver.accessToken);
    const created = await ask(
      app,
      requester.accessToken,
      await inboxRefOf(app, approver.accessToken),
      {
        bindingMessage: "Grant admin on acme/catalog",
        authorizationDetails: [
          { type: "connection_delegation", actions: ["repository.admin"] },
        ],
      },
    );
    const body = slackBody({
      transactionRef: callbackTransactionRef(
        created.authReqId,
        "approved",
        ctx.config.claimPepper,
      ),
    });
    expect((await post(app, body, ctx.clock())).status).toBe(200);
    expect(await statusOf(app, approver.accessToken, created.authReqId)).toBe(
      "pending",
    );
    const reasons = (await auditReasons(ctx)).join(" ");
    expect(reasons).toContain("channel_cannot_meet_assurance");
    // And it demands the step-up by name: a ceremony no channel can run.
    expect(reasons).toContain("activation_required");
  });

  it("adversarial: with no channel opted in, the same callback settles nothing", async () => {
    // Default deny. An operator who has not written a channel down has not
    // permitted it to approve anything.
    const { app, ctx } = plane({
      notifications: { directApprovalChannels: [], directDenialChannels: [] },
    });
    const approver = await principal(app);
    const requester = await principal(app);
    await bindSlack(app, approver.accessToken);
    const created = await ask(
      app,
      requester.accessToken,
      await inboxRefOf(app, approver.accessToken),
    );
    const body = slackBody({
      transactionRef: callbackTransactionRef(
        created.authReqId,
        "approved",
        ctx.config.claimPepper,
      ),
    });
    expect((await post(app, body, ctx.clock())).status).toBe(200);
    expect(await statusOf(app, approver.accessToken, created.authReqId)).toBe(
      "pending",
    );
    expect((await auditReasons(ctx)).join(" ")).toContain(
      "channel_not_permitted_by_policy",
    );
  });

  it("contract: an unconfigured provider is indistinguishable from an unknown one", async () => {
    const { app, ctx } = plane();
    const body = slackBody({ transactionRef: "oscb_nope.nope" });
    const known = await post(app, body, ctx.clock());
    const unknown = await app.request("/v1/notification-callbacks/telegram", {
      method: "POST",
      headers: slackHeaders(body, ctx.clock()),
      body,
    });
    expect(unknown.status).toBe(known.status);
    expect(await unknown.text()).toBe(await known.text());
  });
});

describe("the order of the chain", () => {
  it("property: verify, then parse, then resolve the binding, then claim the replay", async () => {
    // The order is the security property. Parsing before verifying hands
    // attacker-chosen structure to a parser; claiming before resolving would
    // burn a ledger entry on a callback that names nobody.
    const calls: string[] = [];
    const base = createRepositories();
    const repos: Repositories = {
      ...base,
      channelBindings: {
        ...base.channelBindings,
        findByProviderIdentity: async (...args) => {
          calls.push("findByProviderIdentity");
          return base.channelBindings.findByProviderIdentity(...args);
        },
      },
      callbackReplays: {
        ...base.callbackReplays,
        claim: async (record) => {
          calls.push("claim");
          return base.callbackReplays.claim(record);
        },
      },
    };
    const adapter: NotificationCallbackAdapter = {
      kind: "slack",
      providerId: "slack",
      verify({ raw }) {
        calls.push("verify");
        // Proof the raw bytes reached the verifier: a re-serialized body
        // would not carry the sentinel the test put in it.
        expect(Buffer.from(raw).toString("utf8")).toContain("raw-sentinel");
        return {
          authenticated: true,
          fresh: true,
          freshnessSource: "provider_timestamp",
          callbackDigest: "digest-1",
        };
      },
      parse(raw) {
        calls.push("parse");
        const ref =
          new URLSearchParams(Buffer.from(raw).toString("utf8")).get("ref") ??
          "";
        return {
          providerId: "slack",
          providerTenantId: TENANT,
          providerSubjectId: SUBJECT,
          transactionRef: ref,
          decision: "approved",
        };
      },
    };

    const { app, ctx } = plane({ repos, adapters: { slack: adapter } });
    const approver = await principal(app);
    const requester = await principal(app);
    await bindSlack(app, approver.accessToken);
    const created = await ask(
      app,
      requester.accessToken,
      await inboxRefOf(app, approver.accessToken),
    );
    // The binding ceremony above also resolves provider identities; the
    // order under test is the callback's own.
    calls.length = 0;
    const body = new URLSearchParams({
      "raw-sentinel": "1",
      ref: callbackTransactionRef(
        created.authReqId,
        "approved",
        ctx.config.claimPepper,
      ),
    }).toString();
    const res = await app.request("/v1/notification-callbacks/slack", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body,
    });
    expect(res.status).toBe(200);
    expect(calls).toEqual([
      "verify",
      "parse",
      "findByProviderIdentity",
      "claim",
    ]);
    expect(await statusOf(app, approver.accessToken, created.authReqId)).toBe(
      "approved",
    );
  });

  it("property: an unverified callback stops before anything is parsed or looked up", async () => {
    const calls: string[] = [];
    const base = createRepositories();
    const repos: Repositories = {
      ...base,
      channelBindings: {
        ...base.channelBindings,
        findByProviderIdentity: async (...args) => {
          calls.push("findByProviderIdentity");
          return base.channelBindings.findByProviderIdentity(...args);
        },
      },
      callbackReplays: {
        ...base.callbackReplays,
        claim: async (record) => {
          calls.push("claim");
          return base.callbackReplays.claim(record);
        },
      },
    };
    const adapter: NotificationCallbackAdapter = {
      kind: "slack",
      providerId: "slack",
      verify() {
        calls.push("verify");
        return {
          authenticated: false,
          fresh: true,
          freshnessSource: "none",
          callbackDigest: "d",
        };
      },
      parse() {
        calls.push("parse");
        return null;
      },
    };
    const { app } = plane({ repos, adapters: { slack: adapter } });
    const res = await app.request("/v1/notification-callbacks/slack", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "payload=%7B%7D",
    });
    expect(res.status).toBe(200);
    expect(calls).toEqual(["verify"]);
  });
});
