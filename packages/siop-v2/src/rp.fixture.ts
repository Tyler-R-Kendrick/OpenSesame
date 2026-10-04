import { isSiopV2Error } from "./errors.js";
import { buildSelfIssuedIdToken } from "./id-token.js";
import {
  SiopRelyingParty,
  type SiopRelyingPartyConfig,
  SiopRpError,
} from "./rp.js";
import type { p256Pair } from "./test-keys.js";

/** Shared by the relying-party suites; not a test of its own. */
export const ISSUER = "https://pages.example/OpenSesame/identity/siop";
export const CLIENT = "local_00000000-0000-4000-8000-000000000001";
export const REDIRECT = "https://rp.example/callback";
export const T0 = 1_700_000_000_000;

export function relyingParty(overrides: Partial<SiopRelyingPartyConfig> = {}) {
  const clock = { now: T0 };
  const rp = new SiopRelyingParty({
    issuer: ISSUER,
    clientId: CLIENT,
    redirectUri: REDIRECT,
    now: () => clock.now,
    ...overrides,
  });
  return { rp, clock };
}

export async function codeOf<T>(run: () => Promise<T>): Promise<string> {
  try {
    await run();
  } catch (error) {
    if (error instanceof SiopRpError) return error.code;
    if (error instanceof Error && isSiopV2Error(error)) return error.code;
    throw error;
  }
  return "no-refusal";
}

export type Mint = {
  nonce: string;
  audience?: string;
  issuer?: string;
  at?: number;
  ttl?: number;
};

export async function mint(
  keys: Awaited<ReturnType<typeof p256Pair>>,
  input: Mint,
): Promise<string> {
  return buildSelfIssuedIdToken({
    profile: { kind: "dynamic", issuer: input.issuer ?? ISSUER },
    audience: input.audience ?? CLIENT,
    nonce: input.nonce,
    publicJwk: keys.publicJwk,
    signingKey: keys.privateKey,
    nowSeconds: Math.floor((input.at ?? T0) / 1000),
    ttlSeconds: input.ttl ?? 600,
  });
}

export function fragment(idToken: string, state: string): string {
  return `#${new URLSearchParams({ id_token: idToken, state }).toString()}`;
}
