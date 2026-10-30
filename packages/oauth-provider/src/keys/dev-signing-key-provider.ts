import {
  type SigningJwks,
  type SigningKeyProvider,
  type SigningKeyRotationStatus,
  isString,
  overlapCast,
} from "@opensesame/os-domain";
import { readOAuthProviderEnv } from "../env.js";

type SigningJwk = JsonWebKey & {
  kid?: string;
  use?: string;
  x5u?: string;
  x5t?: string;
  "x5t#S256"?: string;
  x5c?: string[];
};

/** Public JWKs are projected, never made by deleting a list of private fields. */
function publicKey(key: SigningJwk): JsonWebKey | undefined {
  const parameters =
    key.kty === "RSA"
      ? (["n", "e"] as const)
      : key.kty === "EC"
        ? (["crv", "x", "y"] as const)
        : key.kty === "OKP"
          ? (["crv", "x"] as const)
          : undefined;
  // An `oct` key has no public representation: `k` is the signing secret.
  if (!parameters || !key.kty) return undefined;
  const published: SigningJwk = { kty: key.kty };
  for (const field of [
    ...parameters,
    "kid",
    "alg",
    "use",
    "x5u",
    "x5t",
    "x5t#S256",
  ] as const) {
    const value = key[field];
    if (isString(value)) published[field] = value;
  }
  for (const field of ["key_ops", "x5c"] as const) {
    const value = key[field];
    if (Array.isArray(value) && value.every(isString)) {
      published[field] = [...value];
    }
  }
  if (key.ext === true || key.ext === false) published.ext = key.ext;
  return published;
}

/**
 * Loads signing keys from process env `OPENSESAME_JWKS_JSON` (public+private JWKS).
 * Fails closed when missing outside development.
 */
export class EnvSigningKeyProvider implements SigningKeyProvider {
  constructor(
    private readonly env: NodeJS.ProcessEnv = process.env,
    private readonly allowEmptyDev = true,
  ) {}

  private parse() {
    const raw = this.env.OPENSESAME_JWKS_JSON;
    if (!raw) {
      if (this.allowEmptyDev && !readOAuthProviderEnv(this.env).isProduction) {
        return { keys: [], kid: "dev-unset" };
      }
      throw new Error("OPENSESAME_JWKS_JSON required in production");
    }
    const parsed = overlapCast<unknown, { keys: readonly SigningJwk[] }>(
      JSON.parse(raw),
    );
    const first = parsed.keys[0];
    const kid = first?.kid != null ? String(first.kid) : "k1";
    return { keys: parsed.keys, kid };
  }

  async getActiveSigningKeys(): Promise<readonly JsonWebKey[]> {
    return this.parse().keys;
  }

  async getJwks(): Promise<SigningJwks> {
    const { keys } = this.parse();
    return {
      keys: keys.flatMap((key) => {
        const published = publicKey(key);
        return published ? [published] : [];
      }),
    };
  }

  async rotationStatus(): Promise<SigningKeyRotationStatus> {
    const { kid } = this.parse();
    return { activeKid: kid, retiringKids: [] };
  }
}
