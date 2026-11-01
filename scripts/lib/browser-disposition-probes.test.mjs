import { describe, expect, it } from "vitest";
import {
  admits,
  drift,
  observe,
  requestFor,
} from "./browser-disposition-probes.mjs";

const ORIGIN = "https://opensesame-labs.github.io";

describe("admits", () => {
  it("admits the wildcard and the exact origin, and nothing else", () => {
    expect(admits("*", ORIGIN)).toBe(true);
    expect(admits(ORIGIN, ORIGIN)).toBe(true);
    expect(admits("https://vault.bitwarden.com", ORIGIN)).toBe(false);
    expect(admits(null, ORIGIN)).toBe(false);
  });
});

describe("requestFor", () => {
  it("builds the preflight a probe describes, from the audited origin", () => {
    expect(
      requestFor(
        {
          stage: "preflight",
          url: "https://api.example.com/x",
          method: "POST",
          request_header_names: ["authorization", "content-type"],
        },
        ORIGIN,
      ),
    ).toEqual({
      method: "OPTIONS",
      url: "https://api.example.com/x",
      headers: {
        origin: ORIGIN,
        "access-control-request-method": "POST",
        "access-control-request-headers": "authorization,content-type",
      },
    });
  });

  it("uses the origin a control probe records, not the audited one", () => {
    const request = requestFor(
      {
        stage: "preflight",
        url: "https://identity.bitwarden.com/connect/token",
        method: "POST",
        request_header_names: ["content-type"],
        origin: "https://vault.bitwarden.com",
      },
      ORIGIN,
    );
    expect(request.headers.origin).toBe("https://vault.bitwarden.com");
  });

  it("sends an unauthenticated GET with no credential of any kind", () => {
    const request = requestFor(
      {
        stage: "unauthenticated-get",
        url: "https://api.example.com/v1/models",
        method: "GET",
        request_header_names: [],
      },
      ORIGIN,
    );
    expect(request.method).toBe("GET");
    expect(Object.keys(request.headers).sort()).toEqual(["accept", "origin"]);
  });

  it("describes the refusal of a key that cannot be right, and an unauthenticated POST", () => {
    const invalid = requestFor(
      {
        stage: "authenticated-invalid-key",
        url: "https://x.example/v1/me",
        method: "GET",
        request_header_names: ["authorization"],
      },
      "https://site.example",
    );
    expect(invalid.method).toBe("GET");
    expect(invalid.headers.origin).toBe("https://site.example");
    expect(invalid.headers.authorization).toBe(
      "Bearer osprobe-invalid-key-0000",
    );
    const post = requestFor(
      {
        stage: "unauthenticated-post",
        url: "https://x.example/v1/c",
        method: "POST",
      },
      "https://site.example",
    );
    expect(post.method).toBe("POST");
    expect(post.headers.authorization).toBeUndefined();
  });

  it("refuses a stage it does not know", () => {
    expect(() =>
      requestFor(
        { stage: "guess", url: "https://x.example", method: "GET" },
        ORIGIN,
      ),
    ).toThrow("Unknown probe stage");
  });
});

describe("observe", () => {
  it("reads browser-access headers in the recorded shape", () => {
    expect(
      observe(204, {
        "access-control-allow-origin": "*",
        "access-control-allow-methods": ["GET", "POST"],
      }),
    ).toEqual({
      status: 204,
      allow_origin: "*",
      allow_methods: "GET, POST",
      allow_headers: null,
    });
  });
});

describe("drift", () => {
  const recorded = { status: 204, allow_origin: null };

  it("reports nothing while the answer still supports the claim", () => {
    expect(
      drift(recorded, { status: 204, allow_origin: null }, ORIGIN),
    ).toBeNull();
    expect(
      drift(
        { status: 200, allow_origin: "*" },
        { status: 200, allow_origin: ORIGIN },
        ORIGIN,
      ),
    ).toBeNull();
  });

  it("reports a provider that has started admitting the origin, which retires a refusal", () => {
    expect(drift(recorded, { status: 204, allow_origin: "*" }, ORIGIN)).toBe(
      "now admits the origin (recorded: it did not)",
    );
  });

  it("reports a provider that stopped admitting it, which retires a pending driver", () => {
    expect(
      drift(
        { status: 200, allow_origin: "*" },
        { status: 200, allow_origin: null },
        ORIGIN,
      ),
    ).toBe("no longer admits the origin (recorded: it did)");
  });

  it("reports a changed status", () => {
    expect(drift(recorded, { status: 403, allow_origin: null }, ORIGIN)).toBe(
      "status 204 -> 403",
    );
  });

  it("judges a control probe against its own origin", () => {
    const control = {
      status: 204,
      allow_origin: "https://vault.bitwarden.com",
      origin: "https://vault.bitwarden.com",
    };
    expect(
      drift(
        control,
        { status: 204, allow_origin: "https://vault.bitwarden.com" },
        ORIGIN,
      ),
    ).toBeNull();
  });
});
