import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  SHIPPED_BASE,
  SHIPPED_ORIGIN,
  SIOP_METADATA_FILE,
  loadDiscovery,
  siopMetadataLocation,
  siopMetadataText,
} from "./lib/siop-metadata.mjs";
import { securityProfile } from "./security-profile.mjs";
import { siopMetadata } from "./siop-metadata-plugin.mjs";

const OTHER = "https://vault.example.org";
const upstreamCi = { GITHUB_REPOSITORY_OWNER: "Tyler-R-Kendrick" };
const forkCi = { GITHUB_REPOSITORY_OWNER: "Someone-Else" };

const named = (origin, basePath) => ({ origin, basePath });
const skipped = (pattern) => ({ skip: expect.stringMatching(pattern) });

describe("which origin a build can name (ADR 0161 §3)", () => {
  // [what, env, base, expected]
  const cases = [
    [
      "the shipped base, by hand, no variable",
      {},
      SHIPPED_BASE,
      named(SHIPPED_ORIGIN, SHIPPED_BASE),
    ],
    [
      "the shipped base in the upstream project's Actions (any letter case)",
      upstreamCi,
      SHIPPED_BASE,
      named(SHIPPED_ORIGIN, SHIPPED_BASE),
    ],
    [
      "a fork's Actions at the shipped base, with no origin of its own",
      forkCi,
      SHIPPED_BASE,
      skipped(/someone-else.*PAGES_CANONICAL_ORIGIN/),
    ],
    [
      "a fork that says its own origin, at the shipped base",
      { ...forkCi, PAGES_CANONICAL_ORIGIN: OTHER },
      SHIPPED_BASE,
      named(OTHER, SHIPPED_BASE),
    ],
    [
      "a fork that names the upstream project's origin as its own",
      { ...forkCi, PAGES_CANONICAL_ORIGIN: SHIPPED_ORIGIN },
      SHIPPED_BASE,
      skipped(/names tyler-r-kendrick's origin.*someone-else/),
    ],
    [
      "a fork under its own base path, with no origin",
      forkCi,
      "/vault/",
      skipped(/PAGES_CANONICAL_ORIGIN for a build under \/vault\//),
    ],
    [
      "a fork under its own base path, with its origin",
      { ...forkCi, PAGES_CANONICAL_ORIGIN: OTHER },
      "/vault/",
      named(OTHER, "/vault/"),
    ],
    [
      "the upstream project under another base, with no origin",
      upstreamCi,
      "/",
      skipped(/PAGES_CANONICAL_ORIGIN for a build under \//),
    ],
    [
      "any base, with an origin and no owner",
      { PAGES_CANONICAL_ORIGIN: OTHER },
      "/",
      named(OTHER, "/"),
    ],
    [
      "the shipped base, with another origin and no owner",
      { PAGES_CANONICAL_ORIGIN: OTHER },
      SHIPPED_BASE,
      named(OTHER, SHIPPED_BASE),
    ],
    [
      "a blank origin (an unset repository variable) says nothing, for a fork",
      { ...forkCi, PAGES_CANONICAL_ORIGIN: "  " },
      SHIPPED_BASE,
      skipped(/someone-else/),
    ],
    [
      "a blank origin says nothing, for the upstream project",
      { ...upstreamCi, PAGES_CANONICAL_ORIGIN: "" },
      SHIPPED_BASE,
      named(SHIPPED_ORIGIN, SHIPPED_BASE),
    ],
    [
      "a blank owner is no owner",
      { GITHUB_REPOSITORY_OWNER: "" },
      SHIPPED_BASE,
      named(SHIPPED_ORIGIN, SHIPPED_BASE),
    ],
  ];
  for (const [what, env, base, expected] of cases) {
    it(`${what}`, () => {
      expect(siopMetadataLocation(env, base)).toEqual(expected);
    });
  }

  it("never names the upstream project's origin from a fork, whatever else is set", () => {
    for (const base of [SHIPPED_BASE, "/", "/vault/", "/OpenSesame/app/"]) {
      for (const extra of [
        {},
        { PAGES_CANONICAL_ORIGIN: SHIPPED_ORIGIN },
        { PAGES_CANONICAL_ORIGIN: `${SHIPPED_ORIGIN}` },
      ]) {
        const where = siopMetadataLocation({ ...forkCi, ...extra }, base);
        expect(where.origin, `${base} ${JSON.stringify(extra)}`).not.toBe(
          SHIPPED_ORIGIN,
        );
      }
    }
  });

  it("agrees with the profile the rest of the build uses about the shipped origin", () => {
    expect(securityProfile({}).canonicalOrigin).toBe(SHIPPED_ORIGIN);
  });

  it("refuses an origin that is not an origin", () => {
    expect(() =>
      siopMetadataLocation(
        { PAGES_CANONICAL_ORIGIN: "https://vault.example.org/path" },
        "/",
      ),
    ).toThrow();
  });

  it("is told what it reads: turbo passes these variables to a build", () => {
    const turbo = JSON.parse(
      readFileSync(new URL("../../../turbo.json", import.meta.url), "utf8"),
    );
    expect(turbo.tasks.build.env).toEqual(
      expect.arrayContaining([
        "PAGES_CANONICAL_ORIGIN",
        "GITHUB_REPOSITORY_OWNER",
      ]),
    );
  });
});

describe("the bytes", () => {
  it("are the kit's serialization, loaded through Vite, for the shipped project", async () => {
    const discovery = await loadDiscovery();
    expect(discovery.SIOP_METADATA_FILE).toBe(SIOP_METADATA_FILE);
    const where = { origin: SHIPPED_ORIGIN, basePath: SHIPPED_BASE };
    const text = await siopMetadataText(where);
    expect(text).toBe(discovery.serializePagesSiopMetadata(where));
    const doc = JSON.parse(text);
    expect(doc.issuer).toBe(`${SHIPPED_ORIGIN}${SHIPPED_BASE}identity/siop`);
    expect(doc).not.toHaveProperty("jwks_uri");
    expect(doc).not.toHaveProperty("token_endpoint");
  });
});

function plugin(env, excluded = []) {
  const emitted = [];
  const warned = [];
  const hooks = siopMetadata({ env });
  const compose = {
    name: "opensesame-capability-compose",
    __state: () => ({ isExcluded: (id) => excluded.includes(id) }),
  };
  hooks.configResolved({
    base: env.BASE ?? SHIPPED_BASE,
    plugins: [{ name: "other" }, compose],
  });
  const context = {
    emitFile: (file) => emitted.push(file),
    warn: (message) => warned.push(message),
  };
  return { hooks, context, emitted, warned };
}

describe("the Vite plugin", () => {
  it("emits one asset at the base path's root", async () => {
    const { hooks, context, emitted, warned } = plugin({});
    await hooks.generateBundle.call(context);
    expect(warned).toEqual([]);
    expect(emitted).toHaveLength(1);
    expect(emitted[0].type).toBe("asset");
    expect(emitted[0].fileName).toBe("siop-metadata.json");
    expect(JSON.parse(emitted[0].source).issuer).toBe(
      `${SHIPPED_ORIGIN}${SHIPPED_BASE}identity/siop`,
    );
  });

  it("emits nothing when the build excludes the capability that owns it", async () => {
    const { hooks, context, emitted, warned } = plugin({}, ["identity.siop"]);
    await hooks.generateBundle.call(context);
    expect(emitted).toEqual([]);
    expect(warned).toEqual([]);
    const other = plugin({}, ["identity.local-iam"]);
    await other.hooks.generateBundle.call(other.context);
    expect(other.emitted).toHaveLength(1);
  });

  it("warns and emits nothing when it cannot say which origin it is", async () => {
    const { hooks, context, emitted, warned } = plugin({ BASE: "/" });
    await hooks.generateBundle.call(context);
    expect(emitted).toEqual([]);
    expect(warned).toHaveLength(1);
  });

  it("publishes nothing from a fork's build, and says why, until the fork names its origin", async () => {
    const fork = plugin({ ...forkCi });
    await fork.hooks.generateBundle.call(fork.context);
    expect(fork.emitted).toEqual([]);
    expect(fork.warned).toHaveLength(1);
    expect(fork.warned[0]).toMatch(/PAGES_CANONICAL_ORIGIN/);

    const named = plugin({ ...forkCi, PAGES_CANONICAL_ORIGIN: OTHER });
    await named.hooks.generateBundle.call(named.context);
    expect(named.warned).toEqual([]);
    expect(JSON.parse(named.emitted[0].source).issuer).toBe(
      `${OTHER}${SHIPPED_BASE}identity/siop`,
    );
  });

  it("names the base the build was given, not the shipped one", async () => {
    const { hooks, context, emitted } = plugin({
      BASE: "/vault/",
      PAGES_CANONICAL_ORIGIN: OTHER,
    });
    await hooks.generateBundle.call(context);
    expect(emitted).toHaveLength(1);
    expect(JSON.parse(emitted[0].source).issuer).toBe(
      `${OTHER}/vault/identity/siop`,
    );
  });

  it("stays inert under test runs", async () => {
    const { hooks, context, emitted } = plugin({ VITEST: "true" });
    await hooks.generateBundle.call(context);
    expect(emitted).toEqual([]);
  });

  it("serves the same path from the dev origin, and only that path", async () => {
    const { hooks } = plugin({});
    let middleware;
    hooks.configureServer({
      middlewares: {
        use: (handler) => {
          middleware = handler;
        },
      },
    });
    const answer = async (url, host) => {
      const headers = {};
      const response = {
        statusCode: 200,
        setHeader: (name, value) => {
          headers[name] = value;
        },
        end: (body) => {
          response.body = body;
        },
      };
      let passed = false;
      await middleware({ url, headers: { host } }, response, () => {
        passed = true;
      });
      return { response, headers, passed };
    };
    const served = await answer(
      `${SHIPPED_BASE}${SIOP_METADATA_FILE}?x=1`,
      "localhost:5180",
    );
    expect(served.passed).toBe(false);
    expect(served.headers["access-control-allow-origin"]).toBe("*");
    expect(JSON.parse(served.response.body).issuer).toBe(
      "http://localhost:5180/OpenSesame/identity/siop",
    );
    expect((await answer("/OpenSesame/vault", "localhost:5180")).passed).toBe(
      true,
    );
    const lan = await answer(
      `${SHIPPED_BASE}${SIOP_METADATA_FILE}`,
      "192.168.1.20:5180",
    );
    expect(lan.response.statusCode).toBe(404);
  });
});

describe("the Vercel deployment", () => {
  it("serves the document with CORS, as GitHub Pages does by itself", () => {
    const config = JSON.parse(
      readFileSync(new URL("../vercel.json", import.meta.url), "utf8"),
    );
    const rule = config.headers.find(
      (entry) => entry.source === `/${SIOP_METADATA_FILE}`,
    );
    expect(rule.headers).toContainEqual({
      key: "Access-Control-Allow-Origin",
      value: "*",
    });
  });
});
