import type {
  CreateOrganizationRequest,
  UpdateOrganizationRequest,
} from "@opensesame/contracts";
import type { Organization } from "@opensesame/os-domain";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createControlPlane } from "../create-app.js";

type Plane = ReturnType<typeof createControlPlane>;
type Credentials = { accessToken: string; principalId: string };

function headers(principal: Credentials) {
  return {
    authorization: `Bearer ${principal.accessToken}`,
    "content-type": "application/json",
  };
}

async function verified(
  app: Plane["app"],
  subject: string,
): Promise<Credentials> {
  const response = await app.request("/v1/principals/provisional", {
    method: "POST",
  });
  expect(response.status).toBe(201);
  const principal: Credentials = await response.json();
  const linked = await app.request("/v1/principals/link-identities", {
    method: "POST",
    headers: headers(principal),
    body: JSON.stringify({
      kind: "oidc",
      issuer: "https://mock.example",
      subject,
      assurance: "verified",
    }),
  });
  expect(linked.status).toBe(201);
  return principal;
}

async function seed(
  plane: Plane,
  owner: Credentials,
  slug: string,
): Promise<Organization> {
  const response = await plane.app.request("/v1/organizations", {
    method: "POST",
    headers: headers(owner),
    body: JSON.stringify({ slug, displayName: `Original ${slug}` }),
  });
  expect(response.status).toBe(201);
  const body: { id: string } = await response.json();
  const row = await plane.ctx.stores.organizations.get(body.id);
  if (!row) throw new Error("organization fixture missing");
  return row;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("concurrent organization issuer requests", () => {
  for (const mode of [
    "create/create",
    "create/update",
    "update/update",
  ] as const) {
    it(`returns one owner and one conflict for ${mode}`, async () => {
      const plane = createControlPlane({
        config: {
          port: 0,
          publicUrl: "http://127.0.0.1:8788",
          issuer: "http://127.0.0.1:8788",
        },
      });
      const { app, ctx } = plane;
      const owners = [
        await verified(app, "first-racer"),
        await verified(app, "second-racer"),
      ] as const;
      const originals: (Organization | undefined)[] = [undefined, undefined];
      if (mode === "update/update")
        originals[0] = await seed(plane, owners[0], "first-existing");
      if (mode !== "create/create")
        originals[1] = await seed(plane, owners[1], "second-existing");
      const beforeMemberships = await Promise.all(
        owners.map((owner) =>
          ctx.stores.organizationMemberships.listByPrincipal(owner.principalId),
        ),
      );
      const beforeEvents = await ctx.repos.auditEvents.list();
      const canonical = "https://claim-race.example/tenant";
      const store = ctx.stores.organizations;
      const originalSet = store.set.bind(store);
      let release = () => {};
      const ready = new Promise<void>((resolve) => {
        release = resolve;
      });
      let arrivals = 0;
      vi.spyOn(store, "set").mockImplementation(async (id, row) => {
        if (
          [row.ssoIssuer, row.samlIssuer].some((value) =>
            value?.startsWith(canonical),
          )
        ) {
          arrivals += 1;
          if (arrivals === 2) release();
          await ready;
        }
        await originalSet(id, row);
      });
      const responses = await Promise.all(
        owners.map((owner, index) => {
          const original = originals[index];
          const body: Partial<CreateOrganizationRequest> &
            UpdateOrganizationRequest = { displayName: `Changed ${index}` };
          if (original) {
            body.ssoClientId = "changed-client";
            body.ssoClientSecret = "changed-secret";
          } else body.slug = `race-${index}`;
          if (index === 0) body.ssoIssuer = canonical;
          else body.samlIssuer = `${canonical}///`;
          return app.request(
            original ? `/v1/organizations/${original.id}` : "/v1/organizations",
            {
              method: original ? "PATCH" : "POST",
              headers: headers(owner),
              body: JSON.stringify(body),
            },
          );
        }),
      );
      expect(arrivals).toBe(2);
      const loserIndex = responses.findIndex(
        (response) => response.status === 409,
      );
      expect(loserIndex).not.toBe(-1);
      const winnerIndex = 1 - loserIndex;
      const loserResponse = responses[loserIndex];
      const winnerResponse = responses[winnerIndex];
      if (!loserResponse || !winnerResponse)
        throw new Error("missing race response");
      expect(winnerResponse.status).toBe(originals[winnerIndex] ? 200 : 201);
      expect(await loserResponse.json()).toMatchObject({
        error: "issuer_taken",
      });
      const winner: { id: string } = await winnerResponse.json();
      expect((await store.findByIssuer(canonical))?.id).toBe(winner.id);
      const loser = originals[loserIndex];
      if (loser) expect(await store.get(loser.id)).toEqual(loser);
      else expect(await store.getBySlug(`race-${loserIndex}`)).toBeUndefined();
      const loserPrincipal = owners[loserIndex];
      if (!loserPrincipal) throw new Error("missing losing principal");
      expect(
        await ctx.stores.organizationMemberships.listByPrincipal(
          loserPrincipal.principalId,
        ),
      ).toEqual(beforeMemberships[loserIndex]);
      const events = await ctx.repos.auditEvents.list();
      const priorIds = new Set(beforeEvents.map((event) => event.id));
      const changes = events.filter(
        (event) =>
          !priorIds.has(event.id) &&
          (event.eventType === "organization.created" ||
            event.eventType === "organization.updated"),
      );
      expect(changes).toHaveLength(1);
      expect(changes[0]?.organizationId).toBe(winner.id);
    });
  }
});
