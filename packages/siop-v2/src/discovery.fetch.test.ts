import { describe, expect, it } from "vitest";
import {
  MAX_SIOP_METADATA_BYTES,
  type MetadataFetch,
  type MetadataResponse,
  fetchSiopMetadata,
  serializePagesSiopMetadata,
} from "./discovery.js";
import { isSiopV2Error } from "./errors.js";

const PROJECT_PAGE = {
  origin: "https://tyler-r-kendrick.github.io",
  basePath: "/OpenSesame/",
} as const;
const ISSUER = "https://tyler-r-kendrick.github.io/OpenSesame/identity/siop";

async function asyncCodeOf<T>(run: () => Promise<T>): Promise<string> {
  try {
    await run();
  } catch (error) {
    if (error instanceof Error && isSiopV2Error(error)) return error.code;
    throw error;
  }
  return "no-refusal";
}

type AnswerInit = {
  ok?: boolean;
  status?: number;
  type?: string | null;
};

function answer(body: string, init: AnswerInit = {}): MetadataResponse {
  const type = init.type === undefined ? "application/json" : init.type;
  return {
    ok: init.ok ?? true,
    status: init.status ?? 200,
    headers: {
      get: (name) => (name.toLowerCase() === "content-type" ? type : null),
    },
    text: async () => body,
  };
}

describe("fetchSiopMetadata", () => {
  const good = serializePagesSiopMetadata(PROJECT_PAGE);

  it("fetches the derived URL without redirects and accepts the document", async () => {
    const seen: Array<{ url: string; redirect: string; accept: string }> = [];
    const fetch: MetadataFetch = async (url, init) => {
      seen.push({ url, redirect: init.redirect, accept: init.headers.accept });
      return answer(good);
    };
    await expect(
      fetchSiopMetadata({ fetch, expectedIssuer: ISSUER }),
    ).resolves.toEqual({ issuer: ISSUER, authorizationEndpoint: ISSUER });
    expect(seen).toEqual([
      {
        url: "https://tyler-r-kendrick.github.io/OpenSesame/siop-metadata.json",
        redirect: "error",
        accept: "application/json",
      },
    ]);
  });

  it("ties an explicit metadata URL to the issuer's origin", async () => {
    const seen: string[] = [];
    const fetch: MetadataFetch = async (url) => {
      seen.push(url);
      return answer(good);
    };
    await expect(
      fetchSiopMetadata({
        fetch,
        expectedIssuer: ISSUER,
        metadataUrl: `${PROJECT_PAGE.origin}/OpenSesame/siop-metadata.json`,
      }),
    ).resolves.toMatchObject({ issuer: ISSUER });
    // Another origin is a different publisher, however the document reads.
    expect(
      await asyncCodeOf(() =>
        fetchSiopMetadata({
          fetch,
          expectedIssuer: ISSUER,
          metadataUrl: "https://evil.example/siop-metadata.json",
        }),
      ),
    ).toBe("malformed_metadata");
    expect(seen).toHaveLength(1);
  });

  it("reads a mirror only when told to, and still pins the issuer", async () => {
    const fetch: MetadataFetch = async () => answer(good);
    const mirror = "https://mirror.example/siop-metadata.json";
    await expect(
      fetchSiopMetadata({
        fetch,
        expectedIssuer: ISSUER,
        metadataUrl: mirror,
        allowMirror: true,
      }),
    ).resolves.toMatchObject({ issuer: ISSUER });
    expect(
      await asyncCodeOf(() =>
        fetchSiopMetadata({
          fetch,
          expectedIssuer: "https://other.example/identity/siop",
          metadataUrl: mirror,
          allowMirror: true,
        }),
      ),
    ).toBe("issuer_mismatch");
  });

  it("refuses plain http unless loopback http is opted into, and then only to loopback", async () => {
    const fetch: MetadataFetch = async () => answer(good);
    const loopback = "http://127.0.0.1:4173/siop-metadata.json";
    expect(
      await asyncCodeOf(() =>
        fetchSiopMetadata({
          fetch,
          expectedIssuer: ISSUER,
          metadataUrl: loopback,
          allowMirror: true,
        }),
      ),
    ).toBe("issuer_mismatch");
    await expect(
      fetchSiopMetadata({
        fetch,
        expectedIssuer: ISSUER,
        metadataUrl: loopback,
        allowMirror: true,
        allowLoopbackHttp: true,
      }),
    ).resolves.toMatchObject({ issuer: ISSUER });
    expect(
      await asyncCodeOf(() =>
        fetchSiopMetadata({
          fetch,
          expectedIssuer: ISSUER,
          metadataUrl: "http://rp.example.com/siop-metadata.json",
          allowMirror: true,
          allowLoopbackHttp: true,
        }),
      ),
    ).toBe("issuer_mismatch");
  });

  it("treats a failed request, a bad status and a redirect as refusals", async () => {
    const throwing: MetadataFetch = async () => {
      throw new TypeError("redirect mode is set to error");
    };
    expect(
      await asyncCodeOf(() =>
        fetchSiopMetadata({ fetch: throwing, expectedIssuer: ISSUER }),
      ),
    ).toBe("malformed_metadata");
    const missing: MetadataFetch = async () =>
      answer("not found", { ok: false, status: 404 });
    expect(
      await asyncCodeOf(() =>
        fetchSiopMetadata({ fetch: missing, expectedIssuer: ISSUER }),
      ),
    ).toBe("malformed_metadata");
  });

  it("refuses the single-page-app fallback a missing file turns into", async () => {
    const spa: MetadataFetch = async () =>
      answer("<!doctype html><html></html>", { type: "text/html" });
    expect(
      await asyncCodeOf(() =>
        fetchSiopMetadata({ fetch: spa, expectedIssuer: ISSUER }),
      ),
    ).toBe("malformed_metadata");
    const untyped: MetadataFetch = async () => answer(good, { type: null });
    expect(
      await asyncCodeOf(() =>
        fetchSiopMetadata({ fetch: untyped, expectedIssuer: ISSUER }),
      ),
    ).toBe("malformed_metadata");
  });

  it("refuses an oversized body and a body that is not JSON", async () => {
    const huge: MetadataFetch = async () =>
      answer(`{"pad":"${"x".repeat(MAX_SIOP_METADATA_BYTES)}"}`);
    expect(
      await asyncCodeOf(() =>
        fetchSiopMetadata({ fetch: huge, expectedIssuer: ISSUER }),
      ),
    ).toBe("limit_exceeded");
    const broken: MetadataFetch = async () => answer("{not json");
    expect(
      await asyncCodeOf(() =>
        fetchSiopMetadata({ fetch: broken, expectedIssuer: ISSUER }),
      ),
    ).toBe("malformed_metadata");
  });
});
