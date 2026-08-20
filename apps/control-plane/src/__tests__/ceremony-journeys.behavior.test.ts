import { describe, expect, it } from "vitest";
import { createControlPlane } from "../create-app.js";
import { type JsonObject, overlapCast } from "@opensesame/os-domain";

/**
 * Behaviour specifications for the ceremony journeys.
 *
 * These are written as journeys rather than endpoint tests: each one reads as
 * the sequence a real person or agent actually performs, so a reader can tell
 * what the product promises without reconstructing it from route handlers.
 * The unit and PACT suites cover the pieces; these cover the paths through
 * them, which is where a change breaks somebody's day rather than an assert.
 *
 * Structured Given/When/Then deliberately without a second test framework:
 * the value of a behaviour spec is that it reads as one, and adding Cucumber
 * would buy that at the cost of a parallel convention, a feature-file dialect,
 * and a step registry to keep in sync with these helpers.
 */

type App = ReturnType<typeof createControlPlane>["app"];

function aDeployment(): App {
  return createControlPlane({
    config: {
      port: 0,
      publicUrl: "http://127.0.0.1:8788",
      issuer: "http://127.0.0.1:8788",
    },
  }).app;
}

async function aGuestArrives(app: App) {
  const res = await app.request("/v1/principals/provisional", {
    method: "POST",
  });
  expect(res.status, "a guest can always start without an account").toBe(201);
  return overlapCast(await res.json());
}

let nonce = 0;
async function someoneSharesAClaim(app: App, ownerToken: string) {
  const res = await app.request("/v1/claims", {
    method: "POST",
    headers: {
      authorization: `Bearer ${ownerToken}`,
      "content-type": "application/json",
      "idempotency-key": `journey-${++nonce}`,
    },
    body: JSON.stringify({
      type: "project",
      targetManifest: { projectId: "prj_journey" },
    }),
  });
  expect(res.status).toBe(201);
  return overlapCast(await res.json());
}

const present = (app: App, token: string, asToken?: string) =>
  app.request("/v1/claims/present", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(asToken ? { authorization: `Bearer ${asToken}` } : undefined),
    },
    body: JSON.stringify({ token }),
  });

const complete = (
  app: App,
  claimId: string,
  accessToken: string,
  body: JsonObject,
) =>
  app.request(`/v1/claims/${claimId}/complete`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${accessToken}`,
      "content-type": "application/json",
      "idempotency-key": `complete-${++nonce}`,
    },
    body: JSON.stringify(body),
  });

describe("Journey: someone shares a claim with a person who has no account", () => {
  it("the guest can accept it, and only with the consent code", async () => {
    // Given a deployment and an owner who has something to share
    const app = aDeployment();
    const owner = await aGuestArrives(app);
    const shared = await someoneSharesAClaim(app, owner.accessToken);

    // And a recipient who has never signed up
    const recipient = await aGuestArrives(app);

    // When the recipient opens the link and it is presented on their behalf
    const presented = await present(
      app,
      shared.claimToken,
      recipient.accessToken,
    );
    expect(presented.status).toBe(200);
    expect((await presented.json()).state).toBe("presented");

    // Then holding the link alone is not enough to accept it
    const withoutCode = await complete(
      app,
      shared.claimId,
      recipient.accessToken,
      { acceptedItemIds: [], claimToken: shared.claimToken },
    );
    expect(
      withoutCode.status,
      "consent needs the code the sharer read out, not just the link",
    ).toBe(400);

    // And with the code the sharer passed along, the guest accepts it
    const accepted = await complete(
      app,
      shared.claimId,
      recipient.accessToken,
      {
        acceptedItemIds: [],
        userCode: shared.userCode,
        claimToken: shared.claimToken,
      },
    );
    expect(accepted.status).toBe(200);
    expect((await accepted.json()).state).toBe("completed");
  });

  it("a link that has already been opened cannot be opened again", async () => {
    // Given a shared claim that somebody has already presented
    const app = aDeployment();
    const owner = await aGuestArrives(app);
    const shared = await someoneSharesAClaim(app, owner.accessToken);
    expect((await present(app, shared.claimToken)).status).toBe(200);

    // When the same link is presented a second time
    const again = await present(app, shared.claimToken);

    // Then it is refused: a claim link is spent by being opened, which is what
    // makes a leaked one detectable rather than quietly shared.
    expect(again.status).toBe(422);
  });
});

/**
 * Given the person has shared the handle that addresses their inbox.
 *
 * Asking someone is not something you can do just by knowing who they are:
 * the person hands out an address, and holding it is what lets you ask.
 */
async function theyShareTheirInboxHandle(
  app: ReturnType<typeof aDeployment>,
  who: { accessToken: string },
): Promise<string> {
  const res = await app.request("/v1/authorization-requests/inbox-ref", {
    headers: { authorization: `Bearer ${who.accessToken}` },
  });
  expect(res.status).toBe(200);
  return (overlapCast(await res.json())).approverRef;
}

describe("Journey: an agent asks a person to authorize something", () => {
  it("the request waits, the person reads what it would do, and answers", async () => {
    // Given a person, and an agent acting on its own behalf
    const app = aDeployment();
    const person = await aGuestArrives(app);
    const agent = await aGuestArrives(app);
    const personsInbox = await theyShareTheirInboxHandle(app, person);

    // When the agent asks for authority it does not have
    const asked = await app.request("/v1/authorization-requests", {
      method: "POST",
      headers: {
        authorization: `Bearer ${agent.accessToken}`,
        "content-type": "application/json",
        "idempotency-key": `journey-ask-${++nonce}`,
      },
      body: JSON.stringify({
        approverRef: personsInbox,
        bindingMessage: "Read acme/catalog issues",
        authorizationDetails: [
          {
            type: "connection_delegation",
            actions: ["repository.read"],
            locations: ["repo:acme/catalog"],
          },
        ],
      }),
    });
    expect(asked.status).toBe(201);
    const request = overlapCast(await asked.json());

    // Then it waits in that person's inbox, described in terms of what it does
    const inbox = await app.request(
      "/v1/authorization-requests?status=pending",
      { headers: { authorization: `Bearer ${person.accessToken}` } },
    );
    const waiting = overlapCast(await inbox.json());
    expect(waiting.requests).toHaveLength(1);
    expect(waiting.requests[0]?.bindingMessage).toBe(
      "Read acme/catalog issues",
    );
    expect(request.authorizationDetails[0]?.actions).toEqual([
      "repository.read",
    ]);

    // And when the person answers, they answer the request they were shown
    const answered = await app.request(
      `/v1/authorization-requests/${request.authReqId}/approve`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${person.accessToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ requestDigest: request.requestDigest }),
      },
    );
    expect(answered.status).toBe(200);
    expect((await answered.json()).status).toBe("approved");

    // And the agent, which has been waiting, learns the answer
    const polled = await app.request(
      `/v1/authorization-requests/${request.authReqId}/poll`,
      { headers: { authorization: `Bearer ${agent.accessToken}` } },
    );
    expect(polled.status).toBe(200);
    expect((await polled.json()).status).toBe("approved");
  });

  it("a request nobody answers expires rather than lingering", async () => {
    // Given a request with the shortest life a caller may ask for
    const app = aDeployment();
    const person = await aGuestArrives(app);
    const agent = await aGuestArrives(app);
    const personsInbox = await theyShareTheirInboxHandle(app, person);
    const asked = await app.request("/v1/authorization-requests", {
      method: "POST",
      headers: {
        authorization: `Bearer ${agent.accessToken}`,
        "content-type": "application/json",
        "idempotency-key": `journey-ttl-${++nonce}`,
      },
      body: JSON.stringify({
        approverRef: personsInbox,
        bindingMessage: "Something nobody gets around to",
        authorizationDetails: [{ type: "connection_delegation" }],
        ttlSeconds: 30,
      }),
    });
    const request = overlapCast(await asked.json());

    // Then it carries a deadline, so a pending request cannot wait forever for
    // an answer that is never coming.
    expect(new Date(request.expiresAt).getTime()).toBeGreaterThan(Date.now());
    expect(new Date(request.expiresAt).getTime()).toBeLessThanOrEqual(
      Date.now() + 30_000,
    );
  });
});
