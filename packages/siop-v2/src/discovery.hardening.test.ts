import { afterEach, describe, expect, it, vi } from "vitest";
import {
  MAX_SIOP_METADATA_BYTES,
  type MetadataFetch,
  type MetadataResponse,
  buildPagesSiopMetadata,
  fetchSiopMetadata,
  parseSiopMetadata,
  serializePagesSiopMetadata,
} from "./discovery.js";
import { isSiopV2Error } from "./errors.js";

const PAGES = {
  origin: "https://tyler-r-kendrick.github.io",
  basePath: "/OpenSesame/",
} as const;
const ISSUER = "https://tyler-r-kendrick.github.io/OpenSesame/identity/siop";
const GOOD = serializePagesSiopMetadata(PAGES);

async function codeOf<T>(run: () => Promise<T>): Promise<string> {
  try {
    await run();
  } catch (error) {
    if (error instanceof Error && isSiopV2Error(error)) return error.code;
    throw error;
  }
  return "no-refusal";
}

/** A response whose body arrives as the given chunks, counting what was pulled. */
function streamed(chunks: Uint8Array[], headers: Record<string, string> = {}) {
  const pulled = { chunks: 0, cancelled: false };
  const response: MetadataResponse = {
    ok: true,
    status: 200,
    headers: {
      get: (name) =>
        name.toLowerCase() === "content-type"
          ? "application/json"
          : (headers[name.toLowerCase()] ?? null),
    },
    body: {
      getReader: () => {
        let at = 0;
        return {
          read: async () => {
            const value = chunks[at];
            at += 1;
            if (value === undefined) return { done: true };
            pulled.chunks += 1;
            return { done: false, value };
          },
          cancel: async () => {
            pulled.cancelled = true;
          },
        };
      },
    },
    text: async () => {
      throw new Error("the body must be read as it arrives, not whole");
    },
  };
  return { response, pulled };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("the body is bounded by bytes, not characters", () => {
  it("cuts a streamed body off at the cap without reading the rest", async () => {
    const chunk = new Uint8Array(MAX_SIOP_METADATA_BYTES / 2 + 1).fill(0x61);
    const { response, pulled } = streamed([chunk, chunk, chunk, chunk]);
    const fetch: MetadataFetch = async () => response;
    expect(
      await codeOf(() => fetchSiopMetadata({ fetch, expectedIssuer: ISSUER })),
    ).toBe("limit_exceeded");
    expect(pulled.cancelled).toBe(true);
    expect(pulled.chunks).toBeLessThan(4);
  });

  it("refuses on a declared content-length before reading anything", async () => {
    const { response, pulled } = streamed([new TextEncoder().encode(GOOD)], {
      "content-length": String(MAX_SIOP_METADATA_BYTES + 1),
    });
    const fetch: MetadataFetch = async () => response;
    expect(
      await codeOf(() => fetchSiopMetadata({ fetch, expectedIssuer: ISSUER })),
    ).toBe("limit_exceeded");
    expect(pulled.chunks).toBe(0);
  });

  it("counts bytes: multi-byte text under the character cap is still over it", async () => {
    // 3 bytes per character: well under the cap in characters, over in bytes.
    const body = `{"pad":"${"€".repeat(MAX_SIOP_METADATA_BYTES / 2)}"}`;
    expect(body.length).toBeLessThan(MAX_SIOP_METADATA_BYTES);
    const whole: MetadataFetch = async () => ({
      ok: true,
      status: 200,
      headers: { get: () => "application/json" },
      text: async () => body,
    });
    expect(
      await codeOf(() =>
        fetchSiopMetadata({ fetch: whole, expectedIssuer: ISSUER }),
      ),
    ).toBe("limit_exceeded");
    const { response } = streamed([new TextEncoder().encode(body)]);
    expect(
      await codeOf(() =>
        fetchSiopMetadata({
          fetch: async () => response,
          expectedIssuer: ISSUER,
        }),
      ),
    ).toBe("limit_exceeded");
  });

  it("reads a document that arrives in pieces", async () => {
    const bytes = new TextEncoder().encode(GOOD);
    const { response } = streamed([
      bytes.slice(0, 100),
      bytes.slice(100, 400),
      bytes.slice(400),
    ]);
    await expect(
      fetchSiopMetadata({
        fetch: async () => response,
        expectedIssuer: ISSUER,
      }),
    ).resolves.toMatchObject({ issuer: ISSUER });
  });
});

describe("the timeout is an AbortController, not AbortSignal.timeout", () => {
  it("aborts a request that never answers, and never calls AbortSignal.timeout", async () => {
    const spy = vi.spyOn(AbortSignal, "timeout");
    const fetch: MetadataFetch = (_url, init) =>
      new Promise((_resolve, reject) => {
        init.signal.addEventListener("abort", () =>
          reject(new DOMException("aborted", "AbortError")),
        );
      });
    expect(
      await codeOf(() =>
        fetchSiopMetadata({ fetch, expectedIssuer: ISSUER, timeoutMs: 20 }),
      ),
    ).toBe("malformed_metadata");
    expect(spy).not.toHaveBeenCalled();
  });

  it("clears its timer once the document is in", async () => {
    vi.useFakeTimers();
    const fetch: MetadataFetch = async () => ({
      ok: true,
      status: 200,
      headers: { get: () => "application/json" },
      text: async () => GOOD,
    });
    await fetchSiopMetadata({ fetch, expectedIssuer: ISSUER });
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("the authorization endpoint is a bare address", () => {
  const withEndpoint = (authorization_endpoint: string) => ({
    ...buildPagesSiopMetadata(PAGES),
    authorization_endpoint,
  });

  it("refuses an endpoint that carries a query", () => {
    for (const endpoint of [`${ISSUER}?prompt=none`, `${ISSUER}?`]) {
      expect(() =>
        parseSiopMetadata(
          JSON.parse(JSON.stringify(withEndpoint(endpoint))),
          ISSUER,
        ),
      ).toThrow();
    }
  });

  it("still accepts the bare endpoint", () => {
    expect(
      parseSiopMetadata(
        JSON.parse(JSON.stringify(withEndpoint(ISSUER))),
        ISSUER,
      ),
    ).toEqual({ issuer: ISSUER, authorizationEndpoint: ISSUER });
  });
});

describe("loopback http is an opt-in for the parser too", () => {
  const LOCAL = "http://localhost:5180/OpenSesame/identity/siop";
  const doc = JSON.parse(
    serializePagesSiopMetadata({
      origin: "http://localhost:5180",
      basePath: "/OpenSesame/",
    }),
  );

  it("refuses a loopback-http issuer by default and accepts it on request", () => {
    expect(() => parseSiopMetadata(doc, LOCAL)).toThrow();
    expect(parseSiopMetadata(doc, LOCAL, { allowLoopbackHttp: true })).toEqual({
      issuer: LOCAL,
      authorizationEndpoint: LOCAL,
    });
  });
});
