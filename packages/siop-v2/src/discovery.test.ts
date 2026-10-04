import { describe, expect, it } from "vitest";
import {
  MAX_SIOP_METADATA_BYTES,
  PAGES_SIOP_EXTENSION,
  SIOP_DRAFT,
  SIOP_METADATA_FILE,
  buildPagesSiopMetadata,
  pagesOriginOf,
  pagesSiopIssuer,
  parseSiopMetadata,
  serializePagesSiopMetadata,
  siopMetadataUrl,
} from "./discovery.js";
import { isSiopV2Error } from "./errors.js";
import { SUPPORT_MATRIX } from "./index.js";
import { STATIC_SIOP_METADATA } from "./issuer.js";

const PROJECT_PAGE = {
  origin: "https://tyler-r-kendrick.github.io",
  basePath: "/OpenSesame/",
} as const;
const ISSUER = "https://tyler-r-kendrick.github.io/OpenSesame/identity/siop";

function codeOf<T>(run: () => T): string {
  try {
    run();
  } catch (error) {
    if (error instanceof Error && isSiopV2Error(error)) return error.code;
    throw error;
  }
  return "no-refusal";
}

describe("pagesSiopIssuer", () => {
  it("is the origin, the base path and the consent route", () => {
    expect(pagesSiopIssuer(PROJECT_PAGE)).toBe(ISSUER);
    expect(
      pagesSiopIssuer({ origin: "https://vault.example.org", basePath: "/" }),
    ).toBe("https://vault.example.org/identity/siop");
  });

  it("normalizes a base path written without its slashes", () => {
    expect(
      pagesSiopIssuer({ origin: PROJECT_PAGE.origin, basePath: "OpenSesame" }),
    ).toBe(ISSUER);
  });

  it("admits loopback http for development and refuses other http", () => {
    expect(
      pagesSiopIssuer({
        origin: "http://localhost:5180",
        basePath: "/OpenSesame/",
      }),
    ).toBe("http://localhost:5180/OpenSesame/identity/siop");
    expect(
      codeOf(() =>
        pagesSiopIssuer({ origin: "http://rp.example.com", basePath: "/" }),
      ),
    ).toBe("issuer_mismatch");
  });

  it("refuses an origin that carries a path, a query or credentials", () => {
    for (const origin of [
      "https://host.example/path",
      "https://host.example/?a=1",
      "https://user@host.example",
      "not a url",
    ]) {
      expect(
        codeOf(() => pagesSiopIssuer({ origin, basePath: "/" })),
        origin,
      ).toMatch(/malformed_metadata|issuer_mismatch/);
    }
  });

  it("refuses a base path with a query or fragment", () => {
    expect(
      codeOf(() =>
        pagesSiopIssuer({ origin: PROJECT_PAGE.origin, basePath: "/a/?q=1" }),
      ),
    ).toBe("malformed_metadata");
  });
});

describe("pagesOriginOf", () => {
  it("splits a deployment URL into origin and base path", () => {
    for (const written of [
      "https://tyler-r-kendrick.github.io/OpenSesame",
      "https://tyler-r-kendrick.github.io/OpenSesame/",
    ]) {
      expect(pagesSiopIssuer(pagesOriginOf(written))).toBe(ISSUER);
    }
    expect(pagesOriginOf("https://vault.example.org")).toEqual({
      origin: "https://vault.example.org",
      basePath: "/",
    });
  });

  it("refuses a URL with a query, fragment or credentials", () => {
    for (const written of [
      "https://host.example/a?x=1",
      "https://host.example/a#x",
      "https://u:p@host.example/a",
      "nope",
    ]) {
      expect(
        codeOf(() => pagesOriginOf(written)),
        written,
      ).toBe("malformed_metadata");
    }
  });
});

describe("siopMetadataUrl", () => {
  it("sits beside the issuer's route, under the base path", () => {
    expect(siopMetadataUrl(ISSUER)).toBe(
      `https://tyler-r-kendrick.github.io/OpenSesame/${SIOP_METADATA_FILE}`,
    );
    expect(siopMetadataUrl("https://vault.example.org/identity/siop")).toBe(
      "https://vault.example.org/siop-metadata.json",
    );
  });

  it("refuses an issuer that is not a Pages consent route", () => {
    expect(codeOf(() => siopMetadataUrl("https://rp.example/v2"))).toBe(
      "malformed_metadata",
    );
  });
});

describe("buildPagesSiopMetadata", () => {
  const doc = buildPagesSiopMetadata(PROJECT_PAGE);

  it("derives every capability from STATIC_SIOP_METADATA (ADR 0139 drift)", () => {
    const { issuer, authorization_endpoint, ...capabilities } =
      STATIC_SIOP_METADATA;
    expect(issuer).toBe("https://self-issued.me/v2");
    expect(authorization_endpoint).toBe("openid:");
    for (const [key, value] of Object.entries(capabilities)) {
      expect(doc, key).toHaveProperty(key, value);
    }
    expect(Object.keys(doc).sort()).toEqual(
      [
        ...Object.keys(capabilities),
        "authorization_endpoint",
        "issuer",
        "opensesame",
        "response_modes_supported",
      ].sort(),
    );
  });

  it("names the Pages issuer and the consent route as its endpoint", () => {
    expect(doc.issuer).toBe(ISSUER);
    expect(doc.authorization_endpoint).toBe(ISSUER);
    expect(doc.response_modes_supported).toEqual(["fragment"]);
  });

  it("claims no token endpoint, no jwks_uri and no conventional OIDC", () => {
    expect(doc).not.toHaveProperty("token_endpoint");
    expect(doc).not.toHaveProperty("jwks_uri");
    expect(doc).not.toHaveProperty("userinfo_endpoint");
    expect(doc).not.toHaveProperty("registration_endpoint");
    expect(doc.opensesame.conventional_oidc).toBe(false);
    expect(doc.opensesame.specification).toBe(
      SUPPORT_MATRIX.specification.draft,
    );
    expect(SIOP_DRAFT).toBe(SUPPORT_MATRIX.specification.draft);
  });

  it("lists the claims the Pages issuer actually mints", () => {
    expect(PAGES_SIOP_EXTENSION.id_token_claims).toEqual([
      "iss",
      "sub",
      "aud",
      "nonce",
      "exp",
      "iat",
      "sub_jwk",
      "i_am_siop",
    ]);
  });

  it("serializes to stable bytes that parse back to the same document", () => {
    const text = serializePagesSiopMetadata(PROJECT_PAGE);
    expect(text.endsWith("}\n")).toBe(true);
    expect(JSON.parse(text)).toEqual(doc);
    expect(serializePagesSiopMetadata(PROJECT_PAGE)).toBe(text);
    expect(text.length).toBeLessThan(MAX_SIOP_METADATA_BYTES);
  });

  it("is accepted by its own consumer for the issuer it names", () => {
    expect(
      parseSiopMetadata(
        JSON.parse(serializePagesSiopMetadata(PROJECT_PAGE)),
        ISSUER,
      ),
    ).toEqual({ issuer: ISSUER, authorizationEndpoint: ISSUER });
  });
});

/** The published document with one field replaced, or removed. */
function docWith(field?: string, value?: string | string[]) {
  const base = JSON.parse(serializePagesSiopMetadata(PROJECT_PAGE));
  if (field === undefined) return base;
  if (value === undefined) delete base[field];
  else base[field] = value;
  return base;
}

describe("parseSiopMetadata — what the relying party refuses", () => {
  it("refuses a document for another issuer", () => {
    expect(
      codeOf(() =>
        parseSiopMetadata(
          docWith("issuer", "https://evil.example/OpenSesame/identity/siop"),
          ISSUER,
        ),
      ),
    ).toBe("issuer_mismatch");
    expect(
      codeOf(() => parseSiopMetadata(docWith("issuer", `${ISSUER}/`), ISSUER)),
    ).toBe("issuer_mismatch");
  });

  it("refuses an authorization endpoint on another origin", () => {
    expect(
      codeOf(() =>
        parseSiopMetadata(
          docWith("authorization_endpoint", "https://evil.example/authorize"),
          ISSUER,
        ),
      ),
    ).toBe("malformed_metadata");
  });

  it("refuses an endpoint with credentials, a fragment or no URL at all", () => {
    for (const authorization_endpoint of [
      "https://u:p@tyler-r-kendrick.github.io/OpenSesame/identity/siop",
      `${ISSUER}#frag`,
      "not a url",
      "openid:",
    ]) {
      expect(
        codeOf(() =>
          parseSiopMetadata(
            docWith("authorization_endpoint", authorization_endpoint),
            ISSUER,
          ),
        ),
        authorization_endpoint,
      ).toBe("malformed_metadata");
    }
    expect(
      codeOf(() =>
        parseSiopMetadata(docWith("authorization_endpoint", undefined), ISSUER),
      ),
    ).toBe("malformed_metadata");
  });

  it("refuses a document that does not promise what the kit consumes", () => {
    for (const field of [
      "response_types_supported",
      "scopes_supported",
      "id_token_signing_alg_values_supported",
      "subject_syntax_types_supported",
    ]) {
      expect(
        codeOf(() => parseSiopMetadata(docWith(field, ["other"]), ISSUER)),
        field,
      ).toBe("malformed_metadata");
      expect(
        codeOf(() => parseSiopMetadata(docWith(field, undefined), ISSUER)),
        `${field} absent`,
      ).toBe("malformed_metadata");
    }
    expect(
      codeOf(() =>
        parseSiopMetadata(
          docWith("response_modes_supported", ["form_post"]),
          ISSUER,
        ),
      ),
    ).toBe("malformed_metadata");
  });

  it("refuses a value that is not a JSON object", () => {
    for (const raw of [[], "x", 1, null]) {
      expect(codeOf(() => parseSiopMetadata(raw, ISSUER))).toBe(
        "malformed_metadata",
      );
    }
  });

  it("refuses an expected issuer that is not an allowed issuer", () => {
    expect(
      codeOf(() =>
        parseSiopMetadata(docWith(), "http://plain.example.com/identity/siop"),
      ),
    ).toBe("issuer_mismatch");
  });

  it("does not hand on fields it did not validate", () => {
    const accepted = parseSiopMetadata(
      docWith("token_endpoint", "https://evil.example/token"),
      ISSUER,
    );
    expect(Object.keys(accepted).sort()).toEqual([
      "authorizationEndpoint",
      "issuer",
    ]);
  });
});
