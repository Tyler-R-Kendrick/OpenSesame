import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  CreateClaimResponseSchema,
  PrincipalMeResponseSchema,
} from "@opensesame/contracts";
import { DEFAULT_PROVISIONAL_QUOTA } from "@opensesame/policy";
import { describe, expect, it } from "vitest";
import {
  assertAtMostWins,
  assertExclusiveClaim,
  assertFailClosedStatuses,
  assertNoSecretFields,
  assertSourceOrder,
  checkThenSetAdmitsDoubleClaim,
  countConcurrentWins,
} from "@opensesame/testing";
import { buildOpenApiDocument } from "../openapi.js";
import { loadConfig } from "../config.js";
import { createControlPlane } from "../create-app.js";
import { serializeKeyed } from "../serialize.js";

const here = dirname(fileURLToPath(import.meta.url));

function src(rel: string): string {
  return readFileSync(join(here, rel), "utf8");
}

async function provisional(app: ReturnType<typeof createControlPlane>["app"]) {
  const res = await app.request("/v1/principals/provisional", {
    method: "POST",
  });
  expect(res.status).toBe(201);
  return (await res.json()) as {
    principalId: string;
    accessToken: string;
  };
}

function plane() {
  return createControlPlane({
    config: {
      port: 0,
      publicUrl: "http://127.0.0.1:8788",
      issuer: "http://127.0.0.1:8788",
      bootstrapPersonalOrganization: false,
    },
  });
}

describe("PACT — Identity plane mutation oracles", () => {
  it("kills the check-then-set mutant", () => {
    checkThenSetAdmitsDoubleClaim();
  });

  it("serializeKeyed waits on the previous tail before mutating", () => {
    assertSourceOrder(src("../serialize.ts"), [
      "tails.set(key, tail)",
      "await previous",
      "return await mutation()",
    ]);
  });

  it("idempotency locks before cache lookup and store", () => {
    assertSourceOrder(src("../middleware/idempotency.ts"), [
      "serializeKeyed(ctx.stores.idempotencyLocks, cacheKey",
      "ctx.stores.idempotency.get(cacheKey)",
      "await next()",
      "ctx.stores.idempotency.set(cacheKey",
    ]);
  });

  it("claims increment the fence before verify and quota before create", () => {
    assertSourceOrder(src("../routes/claims.ts"), [
      "serializeKeyed(ctx.stores.principalMutations, principalId",
      "action: \"claim.create\"",
      "ctx.claims.createClaim",
    ]);
    assertSourceOrder(src("../routes/claims.ts"), [
      "claimApprovalAttempts.set(id, attempts)",
      "verifyUserCode",
    ]);
  });

  it("MFA fingerprints and increments before verify", () => {
    assertSourceOrder(src("../routes/mfa.ts"), [
      "ctx.stores.mfaAnon.set(fingerprint, stamps)",
      "ctx.stores.mfaFailures.set(fenceKey, prior + 1)",
      "ctx.passkeys.verify",
    ]);
  });

  it("organization create serializes quota check before insert", () => {
    assertSourceOrder(src("../routes/organizations.ts"), [
      "serializeKeyed(ctx.stores.principalMutations, principalId",
      "organization.create",
      "ctx.stores.organizations.set",
    ]);
  });

  it("provisional mint fingerprints before create", () => {
    assertSourceOrder(src("../routes/principals.ts"), [
      "ctx.stores.provisionalMints.set(fingerprint, stamps)",
      "createProvisionalPrincipal",
    ]);
  });

  it("audit chain compares digests with timingSafeEqual", () => {
    assertSourceOrder(
      readFileSync(
        join(here, "../../../../packages/audit/src/chain.ts"),
        "utf8",
      ),
      ["timingSafeEqual", "equalDigest", "verifyAuditChain"],
    );
  });
});

describe("PACT — Identity plane property / chaos / authz", () => {
  it("serializeKeyed never overlaps mutations on one key", async () => {
    const tails = new Map<string, Promise<void>>();
    let inflight = 0;
    let max = 0;
    await Promise.all(
      Array.from({ length: 32 }, () =>
        serializeKeyed(tails, "k", async () => {
          inflight += 1;
          max = Math.max(max, inflight);
          await Promise.resolve();
          inflight -= 1;
        }),
      ),
    );
    expect(max).toBe(1);
  });

  it("idempotency serializes concurrent retries to one side effect", async () => {
    const { app } = plane();
    const guest = await provisional(app);
    const body = JSON.stringify({
      type: "project",
      targetManifest: { name: "pact-claim" },
    });
    const headers = {
      authorization: `Bearer ${guest.accessToken}`,
      "content-type": "application/json",
      "idempotency-key": "pact-claim-1",
    };
    const wins = await countConcurrentWins(async () => {
      const res = await app.request("/v1/claims", {
        method: "POST",
        headers,
        body,
      });
      return res.status === 201 && !res.headers.get("Idempotency-Replayed");
    }, 16);
    expect(wins).toBe(1);
  });

  it("organization quota holds under concurrent create", async () => {
    const { app } = plane();
    const guest = await provisional(app);
    const linked = await app.request("/v1/principals/link-identities", {
      method: "POST",
      headers: {
        authorization: `Bearer ${guest.accessToken}`,
        "content-type": "application/json",
        "idempotency-key": "pact-verify",
      },
      body: JSON.stringify({
        kind: "oidc",
        issuer: "https://mock.example",
        subject: "pact-org-owner",
        assurance: "verified",
      }),
    });
    expect(linked.status).toBe(201);

    const statuses = await Promise.all(
      Array.from({ length: 12 }, (_, i) =>
        app.request("/v1/organizations", {
          method: "POST",
          headers: {
            authorization: `Bearer ${guest.accessToken}`,
            "content-type": "application/json",
            "idempotency-key": `pact-org-${i}`,
          },
          body: JSON.stringify({
            slug: `pact-org-${i}`,
            displayName: `Pact ${i}`,
          }),
        }),
      ),
    );
    const created = statuses.filter((s) => s.status === 201).length;
    const denied = statuses.filter((s) => s.status === 403).length;
    expect(created).toBeLessThanOrEqual(10);
    expect(created + denied).toBe(12);
  });

  it("claim quota holds under concurrent create", async () => {
    const { app } = plane();
    const guest = await provisional(app);
    const wins = await assertAtMostWins(
      async () => {
        const res = await app.request("/v1/claims", {
          method: "POST",
          headers: {
            authorization: `Bearer ${guest.accessToken}`,
            "content-type": "application/json",
            "idempotency-key": `pact-claim-quota-${crypto.randomUUID()}`,
          },
          body: JSON.stringify({
            type: "project",
            targetManifest: { name: "quota" },
          }),
        });
        return res.status === 201;
      },
      DEFAULT_PROVISIONAL_QUOTA.maxClaims,
      DEFAULT_PROVISIONAL_QUOTA.maxClaims + 8,
    );
    expect(wins).toBe(DEFAULT_PROVISIONAL_QUOTA.maxClaims);
  });

  it("unauthenticated MFA assertions are fenced globally", async () => {
    const { app } = plane();
    const statuses: number[] = [];
    for (let i = 0; i < 24; i += 1) {
      const res = await app.request("/v1/mfa/passkey/assert", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          credentialId: `cred-${i}`,
          signature: "aaaa",
          clientDataJSON: "",
          authenticatorData: "",
        }),
      });
      statuses.push(res.status);
    }
    expect(statuses.some((s) => s === 429)).toBe(true);
    expect(statuses.every((s) => s === 200 || s === 401 || s === 429)).toBe(
      true,
    );
  });

  it("exclusive in-memory claim wins once", async () => {
    const keys = new Set<string>();
    await assertExclusiveClaim(() => {
      if (keys.has("d1")) return false;
      keys.add("d1");
      return true;
    });
  });
});

describe("PACT — Identity plane contract / fail-closed", () => {
  it("documents fail-closed statuses on claims, me, MFA, and orgs", () => {
    const document = buildOpenApiDocument(
      loadConfig({ OPENSESAME_ENV: "test" }),
    ) as {
      paths: Record<
        string,
        Record<
          string,
          {
            security?: unknown;
            responses?: Record<string, unknown>;
          }
        >
      >;
    };
    assertFailClosedStatuses(document.paths["/v1/claims"]?.post?.responses, [
      "401",
      "403",
    ]);
    assertFailClosedStatuses(
      document.paths["/v1/claims/present"]?.post?.responses,
      ["401"],
    );
    assertFailClosedStatuses(
      document.paths["/v1/claims/{id}/complete"]?.post?.responses,
      ["401", "429"],
    );
    assertFailClosedStatuses(document.paths["/v1/agents"]?.post?.responses, [
      "401",
      "403",
    ]);
    assertFailClosedStatuses(
      document.paths["/v1/claims/{id}"]?.get?.responses,
      ["401"],
    );
    assertFailClosedStatuses(
      document.paths["/v1/principals/me"]?.get?.responses,
      ["401"],
    );
    assertFailClosedStatuses(
      document.paths["/v1/mfa/passkey/assert"]?.post?.responses,
      ["401", "429"],
    );
    assertFailClosedStatuses(
      document.paths["/v1/organizations"]?.post?.responses,
      ["401", "403"],
    );
    for (const [path, methods] of Object.entries(document.paths)) {
      for (const [method, op] of Object.entries(methods)) {
        if (!op?.security) continue;
        try {
          assertFailClosedStatuses(op.responses, ["401"]);
        } catch (err) {
          throw new Error(`${method.toUpperCase()} ${path}: ${(err as Error).message}`);
        }
      }
    }
  });

  it("health and errors carry no secret fields; claims require a bearer", async () => {
    const { app } = plane();
    const live = await app.request("/v1/health/live");
    expect(live.status).toBe(200);
    assertNoSecretFields(await live.json().catch(() => ({ ok: true })));

    const unauth = await app.request("/v1/claims", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: "project", targetManifest: {} }),
    });
    expect(unauth.status).toBe(401);
    assertNoSecretFields(await unauth.json());

    const missingToken = await app.request("/v1/claims/clm_missing");
    expect(missingToken.status).toBe(401);
    assertNoSecretFields(await missingToken.json());
  });

  it("successful claim and me bodies match contracts", async () => {
    const { app } = plane();
    const guest = await provisional(app);
    const me = await app.request("/v1/principals/me", {
      headers: { authorization: `Bearer ${guest.accessToken}` },
    });
    expect(me.status).toBe(200);
    const meBody = await me.json();
    PrincipalMeResponseSchema.parse(meBody);
    assertNoSecretFields(meBody);

    const created = await app.request("/v1/claims", {
      method: "POST",
      headers: {
        authorization: `Bearer ${guest.accessToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        type: "project",
        targetManifest: { name: "contract" },
      }),
    });
    expect(created.status).toBe(201);
    const body = await created.json();
    CreateClaimResponseSchema.parse(body);
    assertNoSecretFields(body, ["claimToken"]);
  });
});
