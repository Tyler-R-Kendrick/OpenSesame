import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  type PendingFederatedAuth,
  decodePending,
  encodePending,
} from "../interactions/federated.js";

/**
 * Fuzzing for the pending-leg cookie parser.
 *
 * `decodePending` is the one place in the federated leg that parses bytes it
 * did not produce. The cookie is httpOnly, but "httpOnly" is a browser
 * promise, not a server-side guarantee: anything that can set a header on the
 * request reaches this function, so it has to survive arbitrary input without
 * throwing and without ever handing back a half-built leg. A `PendingFederatedAuth`
 * missing its verifier or nonce would mean an exchange with nothing bound to it.
 *
 * This lives here rather than in `packages/fuzz` on purpose. Every target in
 * that package imports from `packages/*`; wiring it to an app would invert the
 * dependency direction for one parser. The trade-off is real and worth naming:
 * these cases do not run under `pnpm test:fuzz`'s coverage-guided Jazzer gate,
 * so they explore a seeded, bounded space rather than being guided toward new
 * branches. If the codec ever moves into a package, move this with it.
 *
 * The PRNG is seeded so a failure is reproducible — an unseeded fuzz test that
 * fails once and never again is worse than no fuzz test.
 */

/** xorshift32 — small, deterministic, and good enough to shake out parsers. */
function makeRng(seed: number): () => number {
  let x = seed || 0x9e3779b9;
  return () => {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    return (x >>> 0) / 0x1_0000_0000;
  };
}

const FIELDS = ["issuer", "state", "nonce", "verifier"] as const;
/** v2 provenance (C3). Optional by contract — a v1 cookie must still decode. */
const OPTIONAL_FIELDS = ["providerId", "byoId", "orgId"] as const;
const pendingSchema = z.object({
  issuer: z.string(),
  state: z.string(),
  nonce: z.string(),
  verifier: z.string(),
  kind: z.enum(["oidc", "oauth2"]).optional(),
  providerId: z.string().optional(),
  byoId: z.string().optional(),
  orgId: z.string().optional(),
});

type FuzzValue = string | number | null | { nested: boolean } | string[];
type FuzzCandidate = Record<string, FuzzValue>;

function randomString(rng: () => number, maxLen: number): string {
  const len = Math.floor(rng() * maxLen);
  // Deliberately includes structural characters, quotes, and non-ASCII: the
  // value is JSON-encoded then base64url'd, and both layers must hold.
  const alphabet =
    'abcdefghijklmnopqrstuvwxyz0123456789-_=+/\\{}[]":,. \n\té中😀';
  let out = "";
  for (let i = 0; i < len; i++) {
    out += alphabet[Math.floor(rng() * alphabet.length)] ?? "a";
  }
  return out;
}

function isWellFormed(
  value: ReturnType<typeof decodePending>,
): value is PendingFederatedAuth {
  if (value === undefined) return false;
  const keys = Object.keys(value);
  // Every required field present, nothing outside the known set, and no key
  // carrying `undefined`: an absent optional must be absent, not present-but-
  // undefined, or re-encoding turns it into a `null` the parser then rejects.
  if (!FIELDS.every((field) => keys.includes(field))) return false;
  const known = new Set<string>([...FIELDS, "kind", ...OPTIONAL_FIELDS]);
  if (keys.some((key) => !known.has(key))) return false;
  if (Object.values(value).some((entry) => entry === undefined)) return false;
  return pendingSchema.safeParse(value).success;
}

describe("FUZZ — decodePending survives arbitrary cookie bytes", () => {
  it("never throws and never returns a partial record, over random bytes", () => {
    const rng = makeRng(0x5eed_1234);
    for (let i = 0; i < 20_000; i++) {
      const len = Math.floor(rng() * 96);
      const bytes = Buffer.alloc(len);
      for (let b = 0; b < len; b++) bytes[b] = Math.floor(rng() * 256);
      const encodings = [
        bytes.toString("base64url"),
        bytes.toString("base64"),
        bytes.toString("utf8"),
        bytes.toString("hex"),
      ];
      for (const raw of encodings) {
        const decoded = decodePending(raw);
        expect(decoded === undefined || isWellFormed(decoded)).toBe(true);
      }
    }
  });

  it("never throws on structurally plausible but wrong JSON", () => {
    const rng = makeRng(0xc0ff_ee01);
    for (let i = 0; i < 5_000; i++) {
      // Build an object with a random subset of the fields and random extras,
      // some of which are the right names with the wrong types.
      const candidate: FuzzCandidate = {};
      for (const field of FIELDS) {
        const roll = rng();
        if (roll < 0.25) continue;
        if (roll < 0.4) candidate[field] = Math.floor(rng() * 1000);
        else if (roll < 0.5) candidate[field] = null;
        else if (roll < 0.6) candidate[field] = { nested: true };
        else if (roll < 0.7) candidate[field] = [randomString(rng, 8)];
        else candidate[field] = randomString(rng, 24);
      }
      // v2 provenance (C3/T12): absent must be as acceptable as present, and a
      // present-but-wrong value must sink the whole record rather than being
      // quietly dropped — `providerId: 7` is not a provider id.
      for (const field of OPTIONAL_FIELDS) {
        const roll = rng();
        if (roll < 0.7) continue;
        if (roll < 0.8) candidate[field] = Math.floor(rng() * 1000);
        else if (roll < 0.85) candidate[field] = null;
        else candidate[field] = randomString(rng, 12);
      }
      const kindRoll = rng();
      if (kindRoll > 0.85) candidate.kind = "oidc";
      else if (kindRoll > 0.75) candidate.kind = "oauth2";
      else if (kindRoll > 0.7) candidate.kind = randomString(rng, 6);

      if (rng() < 0.3) candidate[randomString(rng, 6)] = randomString(rng, 6);

      const raw = Buffer.from(JSON.stringify(candidate), "utf8").toString(
        "base64url",
      );
      const decoded = decodePending(raw);
      expect(decoded === undefined || isWellFormed(decoded)).toBe(true);

      // The contract is exact: every field present AND a string, or nothing.
      const shouldDecode = pendingSchema.safeParse(candidate).success;
      expect(decoded !== undefined).toBe(shouldDecode);
    }
  });

  it("never throws on JSON that is not an object at all", () => {
    for (const scalar of [
      "null",
      "true",
      "false",
      "0",
      '"a string"',
      "[]",
      "[1,2,3]",
      '{"__proto__":{"polluted":true}}',
    ]) {
      const raw = Buffer.from(scalar, "utf8").toString("base64url");
      expect(() => decodePending(raw)).not.toThrow();
      const decoded = decodePending(raw);
      expect(decoded === undefined || isWellFormed(decoded)).toBe(true);
    }
    // Prototype pollution attempt must not have taken.
    expect("polluted" in {}).toBe(false);
  });

  it("round-trips any well-formed record it accepts", () => {
    const rng = makeRng(0xfeed_face);
    for (let i = 0; i < 5_000; i++) {
      const pending: PendingFederatedAuth = {
        issuer: randomString(rng, 40),
        state: randomString(rng, 40),
        nonce: randomString(rng, 40),
        verifier: randomString(rng, 60),
        // Each v2 field is present or absent independently: a cookie from
        // before the field existed, and one from the leg that added it, are
        // both live at once during a deploy.
        ...(rng() < 0.5 ? { kind: rng() < 0.5 ? "oidc" : "oauth2" } : undefined),
        ...(rng() < 0.4 ? { providerId: randomString(rng, 12) } : undefined),
        ...(rng() < 0.3 ? { byoId: randomString(rng, 12) } : undefined),
        ...(rng() < 0.3 ? { orgId: randomString(rng, 12) } : undefined),
      };
      const decoded = decodePending(encodePending(pending));
      expect(decoded).toEqual(pending);
      if (!decoded) throw new Error("well-formed pending state was rejected");
      // Stable under a second pass — no lossy normalization creeping in, and
      // no absent field resurrected as a present `undefined`.
      expect(decodePending(encodePending(decoded))).toEqual(pending);
    }
  });
});
