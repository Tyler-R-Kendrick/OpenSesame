import { overlapCast, type SigningKeyProvider } from "@opensesame/os-domain";

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
      if (
        this.allowEmptyDev &&
        (this.env.NODE_ENV ?? "development") !== "production"
      ) {
        return { keys: [], kid: "dev-unset" };
      }
      throw new Error("OPENSESAME_JWKS_JSON required in production");
    }
    const parsed = overlapCast<
      unknown,
      { keys: readonly (JsonWebKey & { kid?: string })[] }
    >(JSON.parse(raw));
    const first = parsed.keys[0];
    const kid = first?.kid != null ? String(first.kid) : "k1";
    return { keys: parsed.keys, kid };
  }

  async getActiveSigningKeys(): Promise<readonly JsonWebKey[]> {
    return this.parse().keys;
  }

  async getJwks(): Promise<{ keys: readonly JsonWebKey[] }> {
    const { keys } = this.parse();
    return {
      keys: keys.map((k) => {
        const pub = { ...k };
        for (const field of ["d", "p", "q", "dp", "dq", "qi"] as const) {
          Reflect.deleteProperty(pub, field);
        }
        return pub;
      }),
    };
  }

  async rotationStatus(): Promise<{
    activeKid: string;
    retiringKids: string[];
  }> {
    const { kid } = this.parse();
    return { activeKid: kid, retiringKids: [] };
  }
}
