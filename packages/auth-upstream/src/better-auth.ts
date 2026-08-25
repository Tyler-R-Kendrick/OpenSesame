import { overlapCast } from "@opensesame/os-domain";
import { betterAuth } from "better-auth";
import { magicLink } from "better-auth/plugins/magic-link";
import { type EmailLinkPolicy, noEmailAutoLinkPolicy } from "./email-link.js";
import type { PrincipalMappingStore } from "./mapping.js";
import type { UpstreamOidcProviderRegistry } from "./oidc-registry.js";
import type { PasskeySeam } from "./passkey.js";

/**
 * Round-trip context a caller attaches to a magic-link request and reads back
 * when the link is delivered — e.g. the interaction the request started from.
 *
 * String values only, deliberately: this travels no further than the callback
 * that builds the URL, and a value that needed parsing there would be a value
 * whose meaning lived somewhere the type could not say.
 */
export type MagicLinkMetadata = Readonly<Record<string, string>>;

/** What Better Auth hands the delivery callback for one magic link. */
export interface MagicLinkDelivery {
  /** The address the human typed. */
  email: string;
  /** The link Better Auth would send, built from its own `baseURL`. */
  url: string;
  /** The single-use verification token, consumed atomically on first verify. */
  token: string;
  /** Whatever the caller passed to `signInMagicLink` — e.g. an interaction uid. */
  metadata?: MagicLinkMetadata;
}

export interface UpstreamMagicLinkOptions {
  /**
   * Deliver the link. The caller may build its own URL from `token` +
   * `metadata` instead of using `url`: OpenSesame lands the link on a control
   * plane route that maps the Better Auth subject to a canonical principal,
   * which is not a page Better Auth knows about.
   */
  sendMagicLink(delivery: MagicLinkDelivery): Promise<void>;
  /** Link lifetime. Better Auth's own default is 300s. */
  expiresInSeconds?: number;
}

export interface CreateUpstreamAuthOptions {
  baseURL: string;
  /**
   * Path prefix the handler is mounted under, e.g. `/v1/auth` (C20). Better
   * Auth's own default is `/api/auth`, which is not a path this API serves.
   */
  basePath: string;
  secret: string;
  mappingStore: PrincipalMappingStore;
  /**
   * NOT wired into Better Auth's social catalog, deliberately (ADR 0057, T22).
   * `toBetterAuthSocialConfig` silently drops every provider without a
   * `clientSecret`, and OpenSesame's brokers are secret-less origin-profile
   * clients — so a registry passed here would half-configure itself and the
   * missing half would be invisible. The provider registry owns social; this
   * bundle carries the registry only so callers can read it back.
   */
  providerRegistry?: UpstreamOidcProviderRegistry;
  passkeySeam?: PasskeySeam;
  /** Origins allowed to POST the magic-link request cross-site (Pages, console). */
  trustedOrigins: string[];
  /** Email magic-link (D16/D18) — the one sign-in method this mount enables. */
  magicLink: UpstreamMagicLinkOptions;
  /**
   * When true, configure Better Auth anonymous plugin surface if available.
   * Mapping layer always supports provisional principals independently.
   */
  enableAnonymous?: boolean;
}

/**
 * A Better Auth user record.
 *
 * `id` is Better Auth's own identifier and is NOT a principal id: it never
 * leaves this package except through the `better_auth_subjects` mapping (T33).
 */
export interface BetterAuthUser {
  id: string;
  email: string;
  emailVerified: boolean;
  name: string;
  createdAt: Date;
  updatedAt: Date;
  image?: string | null | undefined;
}

/**
 * Better Auth's answer to a magic-link request: deliberately just an
 * acknowledgement. It says nothing about whether the address is one this
 * deployment knows, because the request surface is unauthenticated.
 */
export interface MagicLinkRequestAccepted {
  status: boolean;
}

/**
 * A social provider entry as Better Auth's own catalog holds it. Declared only
 * so the facade can say the catalog is empty; nothing configures one (T22).
 */
export interface SocialProviderConfig {
  clientId?: string;
  clientSecret?: string;
}

export interface MagicLinkVerification {
  token: string;
  user: BetterAuthUser;
  session: { id: string; userId: string; token: string; expiresAt: Date };
}

/**
 * The Better Auth surface this package exposes.
 *
 * Written out rather than inferred: Better Auth's inferred instance type names
 * types inside its own `zod@4` copy, which TypeScript cannot reference from a
 * workspace pinned to `zod@3` (TS2742 on declaration emit). Same reason and
 * same shape as the ambient declaration `packages/oauth-provider` keeps for
 * oidc-provider — only the surface OpenSesame actually uses is declared.
 */
export interface UpstreamAuth {
  handler(request: Request): Promise<Response>;
  api: {
    signInMagicLink(input: {
      body: {
        email: string;
        name?: string;
        callbackURL?: string;
        metadata?: MagicLinkMetadata;
      };
      headers: Headers;
    }): Promise<MagicLinkRequestAccepted>;
    magicLinkVerify(input: {
      query: { token: string };
      headers: Headers;
    }): Promise<MagicLinkVerification>;
  };
  options: {
    basePath?: string;
    emailAndPassword?: { enabled?: boolean };
    socialProviders?: Readonly<Record<string, SocialProviderConfig>>;
    account?: { accountLinking?: { enabled?: boolean } };
    trustedOrigins?: string[];
  };
  $context: Promise<{
    internalAdapter: {
      findUserByEmail(
        email: string,
      ): Promise<{ user: BetterAuthUser } | null | undefined>;
    };
  }>;
}

export interface UpstreamAuthBundle {
  auth: UpstreamAuth;
  mappingStore: PrincipalMappingStore;
  passkeySeam?: PasskeySeam | undefined;
  emailLinkPolicy: EmailLinkPolicy;
  providerRegistry?: UpstreamOidcProviderRegistry | undefined;
  /** The complete set of sign-in methods this mount enables (C20). */
  signInMethods: readonly ["magic-link"];
}

/** Better Auth's own default is 5 minutes; a link that travels by email needs longer. */
const DEFAULT_MAGIC_LINK_TTL_SECONDS = 600;

/**
 * Better Auth instance wired for OpenSesame upstream human auth (ADR 0057).
 *
 * Mounted, finally — ADR 0052 §6 rejected mounting it as a federation engine,
 * and that rejection stands for federation: it cannot express a secret-less
 * origin-profile broker, so the openid-client / OAuth2 / SAML legs remain
 * primary. What it does own is email magic-link, plus the passkey machinery it
 * already backs. Social is off here for exactly the reason the old rejection
 * named, and the registry keeps that job.
 *
 * Account linking by email is disabled *inside Better Auth*: its user records
 * are an implementation detail behind `better_auth_subjects`, and letting it
 * fuse two of its own users would silently fuse two canonical principals. The
 * verified-email link ADR 0057 does allow (D15) happens one layer up, in
 * `attachVerifiedExternalIdentity`, against OpenSesame's own identity rows.
 */
export function createUpstreamAuth(
  options: CreateUpstreamAuthOptions,
): UpstreamAuthBundle {
  const built = betterAuth({
    baseURL: options.baseURL,
    basePath: options.basePath,
    secret: options.secret,
    emailAndPassword: {
      enabled: false,
    },
    // Deliberately empty: this mount offers exactly one sign-in method.
    socialProviders: {},
    trustedOrigins: options.trustedOrigins,
    account: {
      accountLinking: {
        enabled: false,
        trustedProviders: [],
      },
    },
    plugins: [
      magicLink({
        expiresIn:
          options.magicLink.expiresInSeconds ?? DEFAULT_MAGIC_LINK_TTL_SECONDS,
        // Stored hashed, so a read of the verification table is not a set of
        // usable sign-in links.
        storeToken: "hashed",
        sendMagicLink: async (data) => {
          // SAFETY: `metadata` is echoed back verbatim from the request that
          // asked for the link, and `signInMagicLink` above only accepts
          // `MagicLinkMetadata` — Better Auth widens it in transit and does not
          // read it.
          const metadata: MagicLinkMetadata | undefined = overlapCast(
            data.metadata,
          );
          await options.magicLink.sendMagicLink({
            email: data.email,
            url: data.url,
            token: data.token,
            ...(metadata !== undefined ? { metadata } : undefined),
          });
        },
      }),
    ],
  });
  // SAFETY: `UpstreamAuth` above is a subset of the instance Better Auth
  // returns; the assertion exists only because the inferred type is not
  // nameable across the zod major boundary, not because the shapes differ.
  const auth: UpstreamAuth = overlapCast(built);

  return {
    auth,
    mappingStore: options.mappingStore,
    passkeySeam: options.passkeySeam,
    emailLinkPolicy: noEmailAutoLinkPolicy,
    providerRegistry: options.providerRegistry,
    signInMethods: ["magic-link"],
  };
}
