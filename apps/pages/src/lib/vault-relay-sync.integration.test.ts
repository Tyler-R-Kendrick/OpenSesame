/** @vitest-environment jsdom */
/**
 * Two devices and one in-memory relay (ADR 0181 §4).
 *
 * Join itself writes nothing. This is the separate consent that follows:
 * the first device pushes a sealed snapshot, and the second device pulls
 * the ciphertext metadata. The harness is the relay's compare-and-set,
 * not a canned response.
 */
import {
  type RelayRequestError,
  type RelaySnapshot,
  createOrgVault,
  listOrgVaults,
  pullRelaySnapshot,
  pushRelaySnapshot,
  relayCiphertextMeta,
} from "@opensesame/app-core/lib/vault-relay/client.js";
import { describe, expect, it } from "vitest";
import { z } from "zod";

const FORMAT = "opensesame-vault-drive-snapshot";
const ITEM_NAME = "Bank login";

type Slot = {
  key: string;
  generation: number;
  snapshot: RelaySnapshot;
  principal: string;
};

const snapshotWriteSchema = z.object({
  expected_generation: z.number(),
  snapshot: z.object({
    format: z.literal(FORMAT),
    v: z.literal(1),
    tomb: z.string(),
    header: z.object({ v: z.literal(1), createdAt: z.string() }),
    body: z.object({ ivB64: z.string(), ctB64: z.string() }),
    rev: z.number(),
  }),
});

function readSlot(current: Slot | undefined, key: string): Response {
  if (!current) return Response.json({ error: "not_found" }, { status: 404 });
  if (current.key !== key) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }
  return Response.json({
    generation: current.generation,
    snapshot: current.snapshot,
  });
}

function writeSlot(
  slots: Map<string, Slot>,
  address: string,
  key: string,
  headers: Headers,
  rawBody: BodyInit | null | undefined,
): Response {
  const current = slots.get(address);
  const body = snapshotWriteSchema.parse(JSON.parse(String(rawBody)));
  if (!current) {
    if (body.expected_generation !== 0) {
      return Response.json({ error: "not_found" }, { status: 404 });
    }
    slots.set(address, {
      key,
      generation: 1,
      snapshot: body.snapshot,
      principal: headers.get("x-opensesame-principal") ?? "",
    });
    return Response.json({ generation: 1 });
  }
  if (current.key !== key) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }
  if (current.generation !== body.expected_generation) {
    return Response.json({ generation: current.generation }, { status: 409 });
  }
  current.generation += 1;
  current.snapshot = body.snapshot;
  return Response.json({ generation: current.generation });
}

function memoryRelay() {
  const slots = new Map<string, Slot>();
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const match = url.pathname.match(
      /^\/v1\/vault-relay\/([^/]+)\/([^/]+)\/snapshot$/,
    );
    if (!match) return new Response(null, { status: 404 });
    const address = `${decodeURIComponent(match[1] ?? "")}/${decodeURIComponent(match[2] ?? "")}`;
    const headers = new Headers(init?.headers);
    const key = headers.get("x-opensesame-slot-key") ?? "";
    const method = init?.method ?? "GET";
    if (method === "GET") return readSlot(slots.get(address), key);
    if (method === "PUT")
      return writeSlot(slots, address, key, headers, init?.body);
    return new Response(null, { status: 404 });
  };
  return fetchImpl;
}

function snapshot(): RelaySnapshot {
  return {
    format: FORMAT,
    v: 1,
    tomb: "personal",
    header: { v: 1, createdAt: "2026-10-07T00:00:00Z" },
    body: { ivB64: "aXY", ctB64: "Y2lwaGVydGV4dA" },
    rev: 3,
  };
}

describe("vault relay join sync", () => {
  it.each([
    { body: "not JSON", generation: null },
    { body: "null", generation: null },
    { body: "[]", generation: null },
    { body: JSON.stringify({ generation: 1 }), generation: null },
    {
      body: JSON.stringify({ generation: "1", snapshot: snapshot() }),
      generation: null,
    },
    {
      body: JSON.stringify({
        generation: 1,
        snapshot: { ...snapshot(), header: null },
      }),
      generation: 1,
    },
    {
      body: JSON.stringify({
        generation: 1,
        snapshot: { ...snapshot(), body: { ivB64: "aXY" } },
      }),
      generation: 1,
    },
  ])(
    "refuses malformed pulled ciphertext contracts: $body",
    async ({ body, generation }) => {
      await expect(
        pullRelaySnapshot({
          baseUrl: "https://relay.test",
          owner: "ada",
          slug: "personal",
          slotKey: "paired-slot-key",
          fetch: async () => new Response(body),
        }),
      ).rejects.toMatchObject({ status: 200, generation });
    },
  );

  it.each([
    { body: null },
    { body: [] },
    { body: { vaults: {} } },
    {
      body: {
        vaults: [{ ownerKind: "invalid", owner: "acme", slug: "ledger" }],
      },
    },
    {
      body: {
        vaults: [{ ownerKind: "organization", owner: 1, slug: "ledger" }],
      },
    },
  ])(
    "refuses malformed organization directory contracts: $body",
    async ({ body }) => {
      await expect(
        listOrgVaults({
          baseUrl: "https://relay.test",
          owner: "acme",
          fetch: async () => Response.json(body),
        }),
      ).rejects.toMatchObject({ status: 200, generation: null });
    },
  );

  it("gives the second device the first device's ciphertext metadata", async () => {
    const fetchImpl = memoryRelay();
    const shared = {
      baseUrl: "https://relay.test",
      owner: "ada",
      slug: "personal",
      slotKey: "test-slot-key",
      fetch: fetchImpl,
    };
    const sealed = snapshot();
    expect(JSON.stringify(sealed)).not.toContain(ITEM_NAME);

    const generation = await pushRelaySnapshot(
      { ...shared, principal: "ada", ownerKind: "user" },
      sealed,
      0,
    );
    const pulled = await pullRelaySnapshot(shared);
    expect(pulled).toBeDefined();
    if (pulled == null) {
      throw new Error("relay pull returned nothing");
    }
    const meta = relayCiphertextMeta(pulled.generation, pulled.snapshot);
    expect(meta).toEqual({
      format: FORMAT,
      tomb: "personal",
      generation,
      ctB64: sealed.body.ctB64,
    });
    expect(JSON.stringify(meta)).not.toContain(ITEM_NAME);
    expect(pulled.generation).toBe(1);

    await expect(pushRelaySnapshot(shared, sealed, 0)).rejects.toMatchObject({
      status: 409,
      generation: 1,
    } satisfies Partial<RelayRequestError>);
  });

  it("creates an org vault and lists it by owner", async () => {
    const vaults = [
      { ownerKind: "organization", owner: "acme", slug: "ledger" },
    ];
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = new URL(String(input));
      if (init?.method === "POST" && url.pathname === "/v1/org-vaults") {
        return Response.json({ vault: vaults[0] }, { status: 201 });
      }
      if (url.pathname === "/v1/org-vaults") {
        expect(url.searchParams.get("owner")).toBe("acme");
        return Response.json({ vaults });
      }
      return new Response(null, { status: 404 });
    };
    const created = await createOrgVault({
      baseUrl: "https://relay.test",
      owner: "acme",
      slug: "ledger",
      ownerKind: "organization",
      principal: "ada",
      fetch: fetchImpl,
    });
    expect(created).toEqual(vaults[0]);
    const listed = await listOrgVaults({
      baseUrl: "https://relay.test",
      owner: "acme",
      fetch: fetchImpl,
    });
    expect(listed).toEqual(vaults);
  });
});
