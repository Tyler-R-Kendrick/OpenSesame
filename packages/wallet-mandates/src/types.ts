export const AP2_LOCAL_PROFILE = "ap2-v0.2-es256-local" as const;
export const UCP_AP2_LOCAL_EXTENSION = "ucp-ap2-mandates-es256-local" as const;
export const MANDATE_ALG = "ES256" as const;

export type MandateConstraints = {
  readonly maxAmount: string;
  readonly currency: string;
  readonly recipient: string;
  readonly assetFingerprint: string;
  readonly protection: "required";
  readonly recurrence: false;
};

export type MandateClaims = {
  readonly iss: string;
  readonly aud: string;
  readonly sub: string;
  readonly jti: string;
  readonly iat: number;
  readonly exp: number;
  readonly role: "cart" | "payment";
  readonly cartHash: string;
  readonly amount: string;
  readonly constraints: MandateConstraints;
  readonly crit: readonly ["constraints", "protection"];
  readonly protection: "required";
};

export type MandateTrust = {
  readonly issuer: string;
  readonly audience: string;
  readonly jwks: ReadonlyMap<string, CryptoKey>;
};

export type MandateVerifyResult =
  | {
      readonly ok: true;
      readonly claims: MandateClaims;
      readonly profile: typeof AP2_LOCAL_PROFILE;
      readonly productionEnabled: false;
      readonly trust: "fixture-local";
    }
  | {
      readonly ok: false;
      readonly reason:
        | "alg_not_es256"
        | "issuer_untrusted"
        | "audience_mismatch"
        | "expired"
        | "constraint_stripped"
        | "protection_downgrade"
        | "amount_mismatch"
        | "duplicate_jti"
        | "signature_invalid"
        | "critical_missing";
    };
