/**
 * Attachments across devices (ADR 0144): a file sealed on one device opens on
 * another through the drive, is kept there for next time, and a file sealed
 * while the drive was out of reach goes up with the next sync pass.
 */
import {
  type ObjectStore,
  type VaultItem,
  createItem,
  memoryObjectStore,
  openFile,
  sealFile,
} from "@opensesame/vault-core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { LocalNetworkFetchInit } from "../local-network-fetch.js";
import { driveClientSeams } from "./client.js";
import { PAIRING } from "./drive.fixture.js";
import {
  driveFileStore,
  listDriveParts,
  putMissingParts,
  referencedParts,
} from "./parts.js";

const original = driveClientSeams.fetch;
/** The drive's parts, as the daemon keeps them; `reachable` cuts it off. */
let held: Map<string, Uint8Array>;
let reachable: boolean;
let requests: string[];

/** The daemon's three part routes, in memory. */
async function fakeDrive(
  url: string,
  init: LocalNetworkFetchInit,
): Promise<Response> {
  if (!reachable) throw new TypeError("Failed to fetch");
  const method = init.method ?? "GET";
  requests.push(`${method} ${url}`);
  const auth = new Headers(init.headers).get("authorization");
  if (auth !== `Bearer ${PAIRING.key}`)
    return new Response(null, { status: 401 });
  const base = `${PAIRING.url}/v1/vault-drive/slots/${PAIRING.slot}/parts`;
  if (url === base) {
    return Response.json({ parts: [...held.keys()].sort() });
  }
  const key = decodeURIComponent(url.slice(base.length + 1));
  if (method === "PUT") {
    if (!held.has(key) && init.body instanceof Uint8Array) {
      held.set(key, init.body.slice());
    }
    return new Response(null, { status: 204 });
  }
  const bytes = held.get(key);
  return bytes ? new Response(bytes) : new Response(null, { status: 404 });
}

const FILE = new TextEncoder().encode(
  "2025 W-2: wages, tips, other compensation",
);

function seal(stores: readonly ObjectStore[]) {
  return sealFile({
    name: "w2.pdf",
    mediaType: "application/pdf",
    bytes: FILE,
    stores,
    partBytes: 16,
  });
}

function itemWith(manifest: string): VaultItem {
  return {
    ...createItem("note", "Taxes 2025"),
    fields: [{ id: "f", name: "W-2", value: manifest, hidden: false }],
  };
}

beforeEach(() => {
  held = new Map();
  reachable = true;
  requests = [];
  driveClientSeams.fetch = fakeDrive;
});

afterEach(() => {
  driveClientSeams.fetch = original;
});

describe("a file sealed on one device", () => {
  it("opens on another through the drive, and offline after", async () => {
    const laptop = memoryObjectStore();
    const manifest = await seal([laptop, driveFileStore(PAIRING, laptop)]);
    expect(held.size).toBe(3);

    const phone = memoryObjectStore();
    const opened = await openFile(manifest, [
      phone,
      driveFileStore(PAIRING, phone),
    ]);
    expect(opened.bytes).toEqual(FILE);

    // Kept on the phone: the drive gone, it still opens.
    reachable = false;
    expect(
      (await openFile(manifest, [phone, driveFileStore(PAIRING, phone)])).bytes,
    ).toEqual(FILE);
  });

  it("is sealed even when the drive cannot be reached, and goes up next pass", async () => {
    const laptop = memoryObjectStore();
    reachable = false;
    const manifest = await seal([laptop, driveFileStore(PAIRING, laptop)]);
    expect(held.size).toBe(0);

    reachable = true;
    expect(await putMissingParts(PAIRING, [itemWith(manifest)], laptop)).toBe(
      3,
    );
    expect((await listDriveParts(PAIRING)).size).toBe(3);
    // Nothing twice.
    expect(await putMissingParts(PAIRING, [itemWith(manifest)], laptop)).toBe(
      0,
    );

    const phone = memoryObjectStore();
    expect(
      (await openFile(manifest, [phone, driveFileStore(PAIRING, phone)])).bytes,
    ).toEqual(FILE);
  });

  it("leaves a part this device never held to the device that sealed it", async () => {
    const elsewhere = memoryObjectStore();
    const manifest = await seal([elsewhere]);
    const here = memoryObjectStore();
    expect(await putMissingParts(PAIRING, [itemWith(manifest)], here)).toBe(0);
    expect(requests.filter((request) => request.startsWith("PUT"))).toEqual([]);
  });

  it("never reaches the drive for a vault without files", async () => {
    expect(
      await putMissingParts(
        PAIRING,
        [createItem("note", "plain")],
        memoryObjectStore(),
      ),
    ).toBe(0);
    expect(requests).toEqual([]);
  });
});

describe("referencedParts", () => {
  it("finds manifests in custom fields and typed values, and nothing else", async () => {
    const manifest = await seal([memoryObjectStore()]);
    const typed: VaultItem = {
      id: "t",
      kind: "typed",
      typeId: "document",
      name: "Passport scan",
      folderId: null,
      favorite: false,
      notes: "{ not a manifest",
      fields: [],
      values: { scan: manifest, number: "123" },
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      deletedAt: null,
    };
    expect(referencedParts([typed]).size).toBe(3);
    expect(referencedParts([itemWith(manifest), typed]).size).toBe(3);
    expect(referencedParts([createItem("note", "{}")]).size).toBe(0);
  });
});
