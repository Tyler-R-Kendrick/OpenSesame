import { type JsonObject, overlapCast } from "@opensesame/os-domain";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createControlPlane } from "../create-app.js";
import {
  type PinnedRequest,
  guardedFetchSeams,
} from "../services/guarded-fetch.js";

/**
 * A client may name a sector only where it can show the sector is its own:
 * every redirect URI on the sector's host (or a subdomain), or an OIDC
 * `sector_identifier_uri` document on that host listing every redirect URI.
 * Runs with dev defaults OFF and only DNS and the wire stubbed.
 */

type Plane = ReturnType<typeof createControlPlane>;

const PUBLIC_ADDRESS = "93.184.216.34";
const originalSeams = { ...guardedFetchSeams };
let dialled: PinnedRequest[] = [];
let documents: Map<string, unknown>;

beforeEach(() => {
  dialled = [];
  documents = new Map();
  guardedFetchSeams.lookup = async () => [
    { address: PUBLIC_ADDRESS, family: 4 },
  ];
  guardedFetchSeams.transport = async (request) => {
    dialled.push(request);
    const body = documents.get(request.url.href);
    return body === undefined
      ? new Response("not found", { status: 404 })
      : Response.json(body);
  };
});

afterEach(() => {
  Object.assign(guardedFetchSeams, originalSeams);
});

function plane(allowDevDefaults: boolean): Plane {
  const pepper = "prod-claim-pepper-for-test-only";
  return createControlPlane({
    config: {
      port: 0,
      publicUrl: "http://127.0.0.1:8788",
      issuer: "http://127.0.0.1:8788",
      allowDevDefaults,
      claimPepper: pepper,
      isProduction: false,
    },
    processEnv: {
      ...process.env,
      OPENSESAME_ALLOW_DEV_DEFAULTS: allowDevDefaults ? "1" : "0",
      OPENSESAME_CLAIM_PEPPER: pepper,
      NODE_ENV: "development",
    },
  });
}

/** A verified principal, raised directly: production linking needs an id_token. */
async function verified(p: Plane): Promise<string> {
  const minted = await p.app.request("/v1/principals/provisional", {
    method: "POST",
  });
  const body = overlapCast(await minted.json());
  const principal = await p.ctx.repos.principals.getById(body.principalId);
  if (!principal) throw new Error("provisional principal missing");
  await p.ctx.repos.principals.update(
    principal.id,
    { assurance: "verified", state: "active" },
    principal.version,
  );
  return body.accessToken;
}

function call(
  p: Plane,
  token: string,
  method: string,
  path: string,
  body: JsonObject,
) {
  return p.app.request(path, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

const register = (p: Plane, token: string, body: JsonObject) =>
  call(p, token, "POST", "/v1/oauth/clients", { displayName: "RP", ...body });

describe("sector control on registration", () => {
  it("admits a client whose redirects all live on the sector's host", async () => {
    const p = plane(false);
    const token = await verified(p);
    const res = await register(p, token, {
      sectorIdentifier: "https://rp-own.example",
      redirectUris: [
        "https://rp-own.example/cb",
        "https://app.rp-own.example/cb",
      ],
    });
    expect(res.status).toBe(201);
    expect(dialled).toHaveLength(0);
  });

  it("refuses redirect hosts outside the sector, loopback included", async () => {
    const p = plane(false);
    const token = await verified(p);
    for (const redirect of [
      "https://attacker.example/cb",
      "https://victim.example.attacker.example/cb",
      "http://127.0.0.1:5173/cb",
      "com.attacker.app:/cb",
    ]) {
      const res = await register(p, token, {
        sectorIdentifier: "https://victim.example",
        redirectUris: ["https://victim.example/cb", redirect],
      });
      expect(res.status, redirect).toBe(400);
      const body = overlapCast(await res.json());
      expect(body.error).toBe("sector_not_proven");
      expect(body.redirectUris).toEqual([redirect]);
    }
    // The sector stays free for whoever can prove it.
    expect(
      await p.ctx.stores.oauthClients.findBySectorKey("victim.example"),
    ).toEqual([]);
  });

  it("admits outside redirects only when the sector's own document lists them", async () => {
    const p = plane(false);
    const token = await verified(p);
    const redirectUris = [
      "https://login.partner.example/cb",
      "com.proven.app:/cb",
    ];
    const doc = "https://proven.example/.well-known/sector.json";
    const attempt = (sectorIdentifierUri: string) =>
      register(p, token, {
        sectorIdentifier: "https://proven.example",
        redirectUris,
        sectorIdentifierUri,
      });

    // Not published yet, then published without every redirect.
    expect((await attempt(doc)).status).toBe(400);
    documents.set(doc, [redirectUris[0]]);
    expect((await attempt(doc)).status).toBe(400);
    // A document on another host proves nothing about this sector.
    const elsewhere = "https://partner.example/sector.json";
    documents.set(elsewhere, redirectUris);
    const before = dialled.length;
    expect((await attempt(elsewhere)).status).toBe(400);
    expect(dialled).toHaveLength(before);

    documents.set(doc, [...redirectUris, "https://proven.example/cb"]);
    expect((await attempt(doc)).status).toBe(201);
    expect(dialled.at(-1)?.url.href).toBe(doc);
    expect(dialled.at(-1)?.address).toBe(PUBLIC_ADDRESS);
  });

  it("holds a redirect change to the same proof", async () => {
    const p = plane(false);
    const token = await verified(p);
    const created = await register(p, token, {
      sectorIdentifier: "https://patched.example",
      redirectUris: ["https://patched.example/cb"],
    });
    expect(created.status).toBe(201);
    const { id } = overlapCast(await created.json());
    const patch = (body: JsonObject) =>
      call(p, token, "PATCH", `/v1/oauth/clients/${id}`, body);

    const moved = { redirectUris: ["https://attacker.example/cb"] };
    expect((await patch(moved)).status).toBe(400);
    const doc = "https://patched.example/sector.json";
    documents.set(doc, moved.redirectUris);
    expect((await patch({ ...moved, sectorIdentifierUri: doc })).status).toBe(
      200,
    );
    // A rename alone is not a redirect change and needs no proof.
    expect((await patch({ displayName: "Renamed" })).status).toBe(200);
  });

  it("lets a dev-defaults deployment register loopback redirects", async () => {
    const p = plane(true);
    const token = await verified(p);
    const res = await register(p, token, {
      sectorIdentifier: "https://local-dev.example",
      redirectUris: ["http://127.0.0.1:5173/callback"],
    });
    expect(res.status).toBe(201);
    const outside = await register(p, token, {
      sectorIdentifier: "https://local-dev-2.example",
      redirectUris: ["https://attacker.example/cb"],
    });
    expect(outside.status).toBe(400);
  });
});
