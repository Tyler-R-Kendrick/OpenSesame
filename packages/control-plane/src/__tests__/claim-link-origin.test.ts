import { overlapCast } from "@opensesame/os-domain";
import { describe, expect, it } from "vitest";
import { createControlPlane } from "../create-app.js";

/**
 * A claim's `verificationUri` points at the one ceremony origin (ADR 0140
 * §4): the client app's `/claim` route when `OPENSESAME_CLIENT_APP_URL` is
 * set, this service's own server-rendered `/v1/claims/<id>/verify` — the
 * zero-JS fallback — when it is not. Every route that mints a claim says the
 * same thing.
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

type Minted = { claimId: string; verificationUri: string };

async function mint(app: App, path: string, body: object): Promise<Minted> {
  const res = await app.request(path, {
    method: "POST",
    headers: await bearer(app),
    body: JSON.stringify(body),
  });
  expect(res.status, path).toBe(201);
  return overlapCast<unknown, Minted>(await res.json());
}

const MINTS: ReadonlyArray<readonly [string, object]> = [
  [
    "/v1/claims",
    {
      type: "resource_bundle",
      targetManifest: { kind: "secret-drop", name: "Deploy token" },
    },
  ],
  ["/v1/projects/temporary", { name: "Short Lived", ttlSeconds: 600 }],
];

describe("claim verificationUri follows the client app (ADR 0140 §4)", () => {
  it.each(MINTS)("%s points at the Pages /claim route", async (path, body) => {
    const app = appWith("https://app.example/OpenSesame/");
    const minted = await mint(app, path, body);
    expect(minted.verificationUri).toBe("https://app.example/OpenSesame/claim");
    // The link carries its path and nothing else: no bearer, no id.
    expect(minted.verificationUri).not.toContain(minted.claimId);
  });

  it.each(MINTS)("%s falls back to the zero-JS page", async (path, body) => {
    const minted = await mint(appWith(), path, body);
    expect(minted.verificationUri).toBe(
      `${PUBLIC_URL}/v1/claims/${minted.claimId}/verify`,
    );
  });
});
