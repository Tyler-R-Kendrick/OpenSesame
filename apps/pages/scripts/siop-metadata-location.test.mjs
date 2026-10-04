import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  SHIPPED_BASE,
  SHIPPED_ORIGIN,
  siopMetadataLocation,
} from "./lib/siop-metadata.mjs";
import { securityProfile } from "./security-profile.mjs";

const OTHER = "https://vault.example.org";
const upstreamCi = { GITHUB_REPOSITORY_OWNER: "Tyler-R-Kendrick" };
const forkCi = { GITHUB_REPOSITORY_OWNER: "Someone-Else" };

const named = (origin, basePath) => ({ origin, basePath });
const skipped = (pattern) => ({ skip: expect.stringMatching(pattern) });

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

describe("which origin a build can name (ADR 0161 §3)", () => {
  // [what, env, base, expected]
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
