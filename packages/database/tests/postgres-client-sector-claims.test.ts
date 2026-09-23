import { randomUUID } from "node:crypto";
import { overlapCast } from "@opensesame/os-domain";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  type ClientRecordStore,
  type OAuthClientRecord,
  OAuthClientSectorClaimedError,
  createPostgresClientRecordStore,
} from "../src/index.js";
import { oauthClients } from "../src/schema/index.js";
import { makePrincipal } from "./factories.js";
import { type PgTestContext, createPgTestContext } from "./pg-harness-full.js";

let ctx: PgTestContext;
let clients: ClientRecordStore;

beforeAll(async () => {
  ctx = await createPgTestContext();
  clients = createPostgresClientRecordStore(ctx.db);
}, 60_000);

afterAll(async () => {
  await ctx.client.close();
});

async function principal(): Promise<string> {
  return (await ctx.repos.principals.create(makePrincipal())).id;
}

function registration(
  ownerPrincipalId: string,
  sectorIdentifier: string,
): OAuthClientRecord {
  return overlapCast({
    id: `cli_${randomUUID()}`,
    ownerPrincipalId,
    admissionMode: "pre_registered",
    displayName: "RP",
    redirectUris: ["https://rp.example/cb"],
    sectorIdentifier,
    grantTypes: ["authorization_code"],
    responseTypes: ["code"],
    tokenEndpointAuthMethod: "none",
    allowedScopes: ["openid"],
    allowedResources: [],
    state: "active",
  });
}

const host = () => `${randomUUID()}.example`;

describe("postgres client store sector claims", () => {
  it("stores the pairwise key and finds every spelling by it", async () => {
    const owner = await principal();
    const h = host();
    const stored = await clients.insertAtomic(
      registration(owner, `https://${h.toUpperCase()}:443/`),
    );
    expect(stored.sectorKey).toBe(h);
    const found = await clients.findBySectorKey(h);
    expect(found.map((c) => c.id)).toEqual([stored.id]);
  });

  it("lets one owner reuse a key and refuses every other owner", async () => {
    const [alice, bob] = [await principal(), await principal()];
    const h = host();
    await clients.insertAtomic(registration(alice, `https://${h}`));
    await clients.insertAtomic(registration(alice, `https://${h}/`));
    await expect(
      clients.insertAtomic(registration(bob, `https://${h.toUpperCase()}`)),
    ).rejects.toBeInstanceOf(OAuthClientSectorClaimedError);
  });

  it("refuses a canonical spelling of a key a legacy row holds", async () => {
    const [alice, bob] = [await principal(), await principal()];
    const h = host();
    const legacy = await clients.insertAtomic(
      registration(alice, `https://${h.toUpperCase()}:443/`),
    );
    expect(legacy.sectorIdentifier).not.toBe(`https://${h}`);
    await expect(
      clients.insertAtomic(registration(bob, `https://${h}`)),
    ).rejects.toMatchObject({ code: "sector_identifier_taken" });
  });

  it("admits exactly one of two concurrent owners on a new key", async () => {
    const [alice, bob] = [await principal(), await principal()];
    const h = host();
    // Two stores stand in for two replicas; only the claim row decides.
    const replica = createPostgresClientRecordStore(ctx.db);
    const results = await Promise.allSettled([
      clients.insertAtomic(registration(alice, `https://${h}`)),
      replica.insertAtomic(registration(bob, `https://${h.toUpperCase()}/`)),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const lost = results.find((r) => r.status === "rejected");
    expect(lost?.status === "rejected" && lost.reason).toBeInstanceOf(
      OAuthClientSectorClaimedError,
    );
    const owners = new Set(
      (await clients.findBySectorKey(h)).map((c) => c.ownerPrincipalId),
    );
    expect(owners.size).toBe(1);
  });

  it("keeps a revoked holder's key from passing to another owner", async () => {
    const [alice, bob] = [await principal(), await principal()];
    const h = host();
    const held = await clients.insertAtomic(
      registration(alice, `https://${h}`),
    );
    await clients.update({ ...held, state: "revoked" });
    await expect(
      clients.insertAtomic(registration(bob, `https://${h}`)),
    ).rejects.toBeInstanceOf(OAuthClientSectorClaimedError);
    // Its owner may still come back to it.
    await expect(
      clients.insertAtomic(registration(alice, `https://${h}`)),
    ).resolves.toHaveProperty("sectorKey", h);
  });

  it("moves a single client's key with its ownership, never onto a shared one", async () => {
    const [system, claimant, other] = [
      await principal(),
      await principal(),
      await principal(),
    ];
    const lone = await clients.insertAtomic(
      registration(system, `sector_${randomUUID()}`),
    );
    const moved = await clients.update({ ...lone, ownerPrincipalId: claimant });
    expect(moved.ownerPrincipalId).toBe(claimant);

    const h = host();
    const first = await clients.insertAtomic(
      registration(system, `https://${h}`),
    );
    await clients.insertAtomic(registration(system, `https://${h}/`));
    await expect(
      clients.update({ ...first, ownerPrincipalId: other }),
    ).rejects.toBeInstanceOf(OAuthClientSectorClaimedError);
  });

  it("keeps a blocked row blocked and editable", async () => {
    const [alice, bob] = [await principal(), await principal()];
    const h = host();
    await clients.insertAtomic(registration(alice, `https://${h}`));
    // A pre-0029 collision, as the migration leaves it.
    const legacy = registration(bob, `https://${h}/`);
    await ctx.db.insert(oauthClients).values({
      ...legacy,
      sectorKey: h,
      sectorKeyBlocked: "cross_owner_collision",
    });
    const renamed = await clients.update({ ...legacy, displayName: "Renamed" });
    expect(renamed.sectorKeyBlocked).toBe("cross_owner_collision");
    const [row] = await ctx.db
      .select()
      .from(oauthClients)
      .where(eq(oauthClients.id, legacy.id));
    expect(row?.sectorKeyBlocked).toBe("cross_owner_collision");
    expect(row?.displayName).toBe("Renamed");
  });

  it("hands a released key to a new owner under a new generation", async () => {
    const [squatter, owner] = [await principal(), await principal()];
    const h = host();
    const squat = await clients.insertAtomic(
      registration(squatter, `https://${h}`),
    );
    expect(squat.sectorGeneration).toBe(0);
    await clients.update({ ...squat, state: "revoked" });
    // Revoking changes nothing: the key stays with the squatter.
    await expect(
      clients.insertAtomic(registration(owner, `https://${h}`)),
    ).rejects.toBeInstanceOf(OAuthClientSectorClaimedError);

    const released = await clients.releaseSectorKey(h);
    expect(released).toMatchObject({
      sectorKey: h,
      previousOwnerKey: squatter,
      generation: 1,
      blockedClientIds: [squat.id],
    });
    expect((await clients.findById(squat.id))?.sectorKeyBlocked).toBe(
      "sector_released",
    );
    const admitted = await clients.insertAtomic(
      registration(owner, `https://${h}`),
    );
    expect(admitted.sectorGeneration).toBe(1);
    // The released client stays blocked through an edit, and a second
    // release of a key nobody holds is a no-op.
    const edited = await clients.update({
      ...squat,
      state: "active",
      displayName: "Back",
    });
    expect(edited.sectorKeyBlocked).toBe("sector_released");
    expect(edited.sectorGeneration).toBe(0);
    expect(await clients.releaseSectorKey(host())).toBeUndefined();
  });

  it("never lets a new registration take a key its holder no longer uses", async () => {
    const [alice, bob] = [await principal(), await principal()];
    const lone = await clients.insertAtomic(
      registration(alice, `https://${host()}`),
    );
    const key = lone.sectorKey ?? "";
    // Alice's only client moves to another sector: she still saw the subjects.
    await clients.update({ ...lone, sectorIdentifier: `https://${host()}` });
    await expect(
      clients.insertAtomic(registration(bob, `https://${key}`)),
    ).rejects.toBeInstanceOf(OAuthClientSectorClaimedError);
  });

  it("holds a released key for a named owner and refuses everyone else", async () => {
    const [squatter, owner] = [await principal(), await principal()];
    const h = host();
    await clients.insertAtomic(registration(squatter, `https://${h}`));
    const released = await clients.releaseSectorKey(h, owner);
    expect(released).toMatchObject({ generation: 1, nextOwnerKey: owner });
    await expect(
      clients.insertAtomic(registration(squatter, `https://${h}`)),
    ).rejects.toBeInstanceOf(OAuthClientSectorClaimedError);
    const admitted = await clients.insertAtomic(
      registration(owner, `https://${h}`),
    );
    expect(admitted.sectorGeneration).toBe(1);
  });
});
