import { overlapCast } from "@opensesame/os-domain";
import { describe, expect, it } from "vitest";
import { createControlPlane } from "../create-app.js";

/**
 * A claim's `verificationUri` points at the one ceremony origin (ADR 0140
 * §4): the client app's `/claim` route when `OPENSESAME_CLIENT_APP_URL` is
 * set, this service's own server-rendered `/v1/claims/<id>/verify` — the
 * zero-JS fallback — when it is not. Every route that mints a claim says the
 * same thing.
 *
 * Beside it, `verificationUriComplete` (RFC 8628 §3.3.1) is the link a person
 * can open without being asked for a bearer they were never given: the
 * `/claim` route with the claim token in the fragment, so the token reaches
 * no request line, server log or `Referer`. The user code stays the second
 * factor (ADR 0062). With no client app the field is absent: the zero-JS page
 * cannot complete a claim.
 */

type App = ReturnType<typeof createControlPlane>["app"];

const PUBLIC_URL = "http://127.0.0.1:8788";

function appWith(clientAppUrl?: string): App {
  return createControlPlane({
    config: {
      port: 0,
      publicUrl: PUBLIC_URL,
      issuer: PUBLIC_URL,
      ...(clientAppUrl ? { clientAppUrl } : undefined),
    },
  }).app;
}

async function bearer(app: App): Promise<Record<string, string>> {
  const res = await app.request("/v1/principals/provisional", {
    method: "POST",
  });
  expect(res.status).toBe(201);
  const { accessToken } = overlapCast<unknown, { accessToken: string }>(
    await res.json(),
  );
  return {
    authorization: `Bearer ${accessToken}`,
    "content-type": "application/json",
  };
}

type Minted = {
  claimId: string;
  claimToken: string;
  userCode: string;
  verificationUri: string;
  verificationUriComplete?: string;
};

async function post(
  app: App,
  path: string,
  body: object,
  headers: Record<string, string>,
): Promise<Minted & { agentId?: string }> {
  const res = await app.request(path, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  expect(res.status, path).toBe(201);
  return overlapCast<unknown, Minted & { agentId?: string }>(await res.json());
}

async function mint(app: App, path: string, body: object): Promise<Minted> {
  return post(app, path, body, await bearer(app));
}

/** `POST /v1/agents/:id/claim`: a new claim for an agent already registered. */
async function mintAgentClaim(app: App): Promise<Minted> {
  const headers = await bearer(app);
  const { agentId } = await post(app, "/v1/agents", AGENT, headers);
  return post(app, `/v1/agents/${String(agentId)}/claim`, {}, headers);
}

const AGENT = {
  displayName: "claim-link agent",
  publicKeyJkt: "jkt-claim-link",
};

const MINTS: ReadonlyArray<readonly [string, object]> = [
  [
    "/v1/claims",
    {
      type: "resource_bundle",
      targetManifest: { kind: "secret-drop", name: "Deploy token" },
    },
  ],
  ["/v1/projects/temporary", { name: "Short Lived", ttlSeconds: 600 }],
  ["/v1/agents", AGENT],
];

describe("claim verificationUri follows the client app (ADR 0140 §4)", () => {
  it.each(MINTS)("%s points at the Pages /claim route", async (path, body) => {
    const app = appWith("https://app.example/OpenSesame/");
    const minted = await mint(app, path, body);
    expect(minted.verificationUri).toBe("https://app.example/OpenSesame/claim");
    // The link carries its path and nothing else: no bearer, no id.
    expect(minted.verificationUri).not.toContain(minted.claimId);
    expect(minted.verificationUri).not.toContain(minted.claimToken);
  });

  it.each(MINTS)(
    "%s returns the complete link, bearer in the fragment only",
    async (path, body) => {
      const app = appWith("https://app.example/OpenSesame/");
      expectComplete(await mint(app, path, body));
    },
  );

  it.each(MINTS)("%s falls back to the zero-JS page", async (path, body) => {
    const minted = await mint(appWith(), path, body);
    expect(minted.verificationUri).toBe(
      `${PUBLIC_URL}/v1/claims/${minted.claimId}/verify`,
    );
    // The zero-JS page cannot complete a claim, so there is no link to it.
    expect(minted).not.toHaveProperty("verificationUriComplete");
  });

  it("POST /v1/agents/:id/claim returns the same links", async () => {
    const app = appWith("https://app.example/OpenSesame/");
    expectComplete(await mintAgentClaim(app));
    const fallback = await mintAgentClaim(appWith());
    expect(fallback.verificationUri).toBe(
      `${PUBLIC_URL}/v1/claims/${fallback.claimId}/verify`,
    );
    expect(fallback).not.toHaveProperty("verificationUriComplete");
  });
});

function expectComplete(minted: Minted): void {
  expect(minted.claimToken).toMatch(/^osc_clm_/);
  expect(minted.verificationUriComplete).toBe(
    `https://app.example/OpenSesame/claim#token=${minted.claimToken}`,
  );
  const link = new URL(String(minted.verificationUriComplete));
  // Everything a server or a Referer sees is the bare route.
  expect(`${link.origin}${link.pathname}${link.search}`).toBe(
    minted.verificationUri,
  );
  expect(link.search).toBe("");
  // The fragment is the bearer and nothing else — above all not the user
  // code, the second factor the person types (ADR 0062).
  expect([...new URLSearchParams(link.hash.slice(1)).keys()]).toEqual([
    "token",
  ]);
  expect(link.href).not.toContain(minted.userCode);
}
