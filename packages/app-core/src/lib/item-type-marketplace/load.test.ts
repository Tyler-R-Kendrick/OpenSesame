import { sha256 } from "@noble/hashes/sha2";
import { bytesToHex } from "@noble/hashes/utils";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MarketplaceError, loadMarketplace, marketplaceFetch } from "./load.js";
import { parseMarketplaceSource } from "./source.js";

const VEHICLE = JSON.stringify({
  apiVersion: "opensesame.dev/v1alpha1",
  kind: "VaultItemType",
  metadata: {
    id: "vehicle-test",
    version: "1.0.0",
    publisher: "https://example.org",
  },
  spec: {
    title: "Vehicle",
    plural: "Vehicles",
    extension: ".vtest",
    summary: "A car for the loader test.",
    categories: [],
    sections: [
      {
        id: "car",
        title: "Car",
        fields: [
          { id: "make", type: "string", label: "Make" },
          { id: "vin", type: "concealed", label: "VIN" },
        ],
      },
    ],
    native: { secret: "vin", trailer: [{ key: "make", field: "make" }] },
    cxf: { credential: "custom-fields" },
    subtitle: ["make"],
    search: ["make"],
  },
});

const digest = (text: string) =>
  bytesToHex(sha256(new TextEncoder().encode(text)));

function index(itemTypes: unknown[]) {
  return JSON.stringify({
    apiVersion: "opensesame.dev/v1alpha1",
    kind: "Marketplace",
    metadata: { name: "Example", description: "Types for testing" },
    spec: { itemTypes },
  });
}

const original = marketplaceFetch.fetch;
afterEach(() => {
  marketplaceFetch.fetch = original;
});

function serve(files: Record<string, string>) {
  const calls: { url: string; init: RequestInit | undefined }[] = [];
  marketplaceFetch.fetch = vi.fn(async (input, init) => {
    const url = String(input);
    calls.push({ url, init });
    const body = files[url];
    return body === undefined
      ? new Response("missing", { status: 404 })
      : new Response(body, { status: 200 });
  });
  return calls;
}

const BASE = "https://raw.githubusercontent.com/octo/types/HEAD";
const source = () => {
  const parsed = parseMarketplaceSource("octo/types");
  if (!parsed) throw new Error("unparsed");
  return parsed;
};

describe("loadMarketplace", () => {
  it("reads the index and every definition, anonymously and without redirects", async () => {
    const calls = serve({
      [`${BASE}/.opensesame/marketplace.json`]: index([
        { path: "types/vehicle.json", sha256: digest(VEHICLE) },
      ]),
      [`${BASE}/types/vehicle.json`]: VEHICLE,
    });
    const listing = await loadMarketplace(source());
    expect(listing.name).toBe("Example");
    expect(listing.offers).toHaveLength(1);
    const [offer] = listing.offers;
    expect(offer?.ok && offer.definition.metadata.id).toBe("vehicle-test");
    for (const call of calls) {
      expect(call.init?.credentials).toBe("omit");
      expect(call.init?.redirect).toBe("error");
      expect(call.init?.referrerPolicy).toBe("no-referrer");
    }
  });

  it("refuses a definition whose bytes do not match its pin", async () => {
    serve({
      [`${BASE}/.opensesame/marketplace.json`]: index([
        { path: "types/vehicle.json", sha256: "0".repeat(64) },
      ]),
      [`${BASE}/types/vehicle.json`]: VEHICLE,
    });
    const [offer] = (await loadMarketplace(source())).offers;
    expect(offer).toMatchObject({
      ok: false,
      problem: expect.stringMatching(/SHA-256/),
    });
  });

  it("keeps a definition the parser refuses as an offer that cannot install", async () => {
    const withHandler = VEHICLE.replace(
      '"cxf"',
      '"handler":"certificate","cxf"',
    );
    serve({
      [`${BASE}/.opensesame/marketplace.json`]: index([
        { path: "bad.json" },
        { path: "gone.json" },
      ]),
      [`${BASE}/bad.json`]: withHandler,
    });
    const offers = (await loadMarketplace(source())).offers;
    expect(offers.map((offer) => offer.ok)).toEqual([false, false]);
  });

  it("names a repository with no index", async () => {
    serve({});
    await expect(loadMarketplace(source())).rejects.toMatchObject({
      failure: "missing",
    });
  });

  it("refuses a malformed index", async () => {
    serve({ [`${BASE}/.opensesame/marketplace.json`]: "{}" });
    await expect(loadMarketplace(source())).rejects.toBeInstanceOf(
      MarketplaceError,
    );
  });

  it("asks Bitbucket for its main branch before reading files", async () => {
    const bitbucket = parseMarketplaceSource("bitbucket:ws/types");
    if (!bitbucket) throw new Error("unparsed");
    serve({
      "https://api.bitbucket.org/2.0/repositories/ws/types": JSON.stringify({
        mainbranch: { name: "trunk" },
      }),
      "https://api.bitbucket.org/2.0/repositories/ws/types/src/trunk/.opensesame/marketplace.json":
        index([]),
    });
    expect((await loadMarketplace(bitbucket)).offers).toEqual([]);
  });

  it("stops reading a body past its cap", async () => {
    serve({
      [`${BASE}/.opensesame/marketplace.json`]: index([{ path: "big.json" }]),
      [`${BASE}/big.json`]: " ".repeat(70_000),
    });
    const [offer] = (await loadMarketplace(source())).offers;
    expect(offer).toMatchObject({
      ok: false,
      problem: expect.stringMatching(/exceeds/),
    });
  });
});
