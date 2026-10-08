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

const FORMAT = "opensesame-vault-drive-snapshot";
const ITEM_NAME = "Bank login";

type Slot = {
  key: string;
  generation: number;
  snapshot: RelaySnapshot;
  principal: string;
};

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
  const body = JSON.parse(String(rawBody)) as {
    expected_generation: number;
    snapshot: RelaySnapshot;
  };
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
  it("gives the second device the first device's ciphertext metadata", async () => {
    const fetchImpl = memoryRelay();
    const shared = {
      baseUrl: "https://relay.test",
      owner: "ada",
      slug: "personal",
      slotKey: "c2xvdC1rZXktMzItYnl0ZXMtcGFkZGVkLW91dA",
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
