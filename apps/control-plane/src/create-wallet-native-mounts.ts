/**
 * Default composition of the ADR 0086 / ADR 0119 wallet-native surfaces.
 *
 * Each surface is either a real router or omitted (so `mountWalletNativeRoutes`
 * keeps its typed Unavailable stub). Tests may still pass an explicit
 * `walletNative: {}` to force every stub; production and ordinary
 * `createControlPlane()` calls get the mounts below.
 */

import { generateKeyPairSync } from "node:crypto";
import type { Database } from "@opensesame/database";
import { overlapCast } from "@opensesame/os-domain";
import {
  InMemoryWalletRegistrationStore,
  createWalletLauncherProvider,
} from "@opensesame/wallet";
import { Hono } from "hono";
import type { ControlPlaneConfig } from "./config.js";
import type { Variables } from "./middleware/context.js";
import { DurableMap, type SecurityMap } from "./repos/durable-map.js";
import { DurableOpenid4vpSessionStore } from "./repos/durable-openid4vp-session-store.js";
import { DurableWalletRegistrationStore } from "./repos/durable-wallet-registration-store.js";
import {
  DurableAccessTokenStore,
  DurableNonceStore,
  DurableOfferStore,
  DurablePreAuthorizedCodeStore,
} from "./repos/openid4vci-stores.js";
import { createOpenid4vciRoutes } from "./routes/openid4vci.js";
import {
  type Openid4vpRouteOptions,
  createOpenid4vpRoutes,
} from "./routes/openid4vp.js";
import { createRendezvousRoutes } from "./routes/rendezvous.js";
import type { WalletNativeMounts } from "./routes/wallet-native.js";
import { createWalletRegistrationRoutes } from "./routes/wallet-registration.js";

export interface ResolveWalletNativeMountsInput {
  readonly config: ControlPlaneConfig;
  readonly processEnv: NodeJS.ProcessEnv;
  readonly clock: () => Date;
  /** When set, wallet registration, OID4VP sessions, and OID4VCI stores use DurableMap. */
  readonly database?: Database | undefined;
  /**
   * Explicit override from `CreateControlPlaneOptions`. When provided (even as
   * `{}`), it wins entirely so suites can pin Unavailable stubs.
   */
  readonly override?: WalletNativeMounts | undefined;
  /** Test/operator seam: trusted issuers for presentation finish. */
  readonly openid4vpTrustedIssuers?: Openid4vpRouteOptions["trustedIssuers"];
}

const OPENSESAME_VCT =
  "https://credentials.opensesame.local/opensesame-holder-binding/v1";
const OPENSESAME_CREDENTIAL_CONFIGURATION_ID = "opensesame-holder-binding";

/**
 * Ephemeral ES256 issuer key for local/dev OID4VCI. Production deployments
 * must replace this with a configured durable issuer key before advertising
 * the issuer publicly; the flag alone is not a trust root.
 *
 * jose's CompactSign accepts a Node KeyObject (or a CryptoKey / JWK). Raw
 * PKCS8 bytes are typed on the runtime seam but are not a signing key.
 */
function ephemeralIssuerKey(): CryptoKey {
  const { privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  return overlapCast(privateKey);
}

function oid4vciStore<T>(
  database: Database | undefined,
  model: string,
  secretKeys: boolean,
): SecurityMap<T> {
  return database ? new DurableMap<T>(database, model, secretKeys) : new Map();
}

/**
 * Build the mounts a deployment should expose.
 *
 * Wallet registration and rendezvous are always mounted. OpenID4VP / OpenID4VCI
 * follow `protocolFeatures`.
 */
export function resolveWalletNativeMounts(
  input: ResolveWalletNativeMountsInput,
): WalletNativeMounts {
  if (input.override !== undefined) return input.override;

  const mounts: {
    -readonly [K in keyof WalletNativeMounts]?: WalletNativeMounts[K];
  } = {};

  const walletRoot = new Hono<{ Variables: Variables }>();
  walletRoot.route(
    "/registrations",
    createWalletRegistrationRoutes({
      provider: createWalletLauncherProvider(input.processEnv),
      store: input.database
        ? new DurableWalletRegistrationStore(input.database, input.clock)
        : new InMemoryWalletRegistrationStore(input.clock),
    }),
  );
  mounts.walletRegistration = walletRoot;
  mounts.rendezvous = createRendezvousRoutes();

  if (input.config.protocolFeatures.oid4vp) {
    mounts.openid4vpVerifier = createOpenid4vpRoutes({
      publicUrl: input.config.publicUrl,
      clock: input.clock,
      vct: OPENSESAME_VCT,
      ...(input.openid4vpTrustedIssuers
        ? { trustedIssuers: input.openid4vpTrustedIssuers }
        : undefined),
      ...(input.database
        ? { sessionStore: new DurableOpenid4vpSessionStore(input.database) }
        : undefined),
    });
  }

  if (input.config.protocolFeatures.oid4vci) {
    const issuer = input.config.issuer.replace(/\/$/, "");
    mounts.openid4vciIssuer = createOpenid4vciRoutes({
      issuer,
      vct: OPENSESAME_VCT,
      credentialConfigurationId: OPENSESAME_CREDENTIAL_CONFIGURATION_ID,
      signing: { key: ephemeralIssuerKey(), algorithm: "ES256" },
      subjectPepper: input.config.claimPepper,
      credentialLifetimeSeconds: 86_400,
      offerTtlSeconds: 300,
      nonceTtlSeconds: 120,
      accessTokenTtlSeconds: 120,
      grants: new DurablePreAuthorizedCodeStore(
        oid4vciStore(input.database, "OpenSesame:Oid4vciGrant", true),
      ),
      nonces: new DurableNonceStore(
        oid4vciStore(input.database, "OpenSesame:Oid4vciNonce", true),
        120,
      ),
      offers: new DurableOfferStore(
        oid4vciStore(input.database, "OpenSesame:Oid4vciOffer", false),
      ),
      accessTokens: new DurableAccessTokenStore(
        oid4vciStore(input.database, "OpenSesame:Oid4vciAccessToken", true),
      ),
      clock: input.clock,
    });
  }

  return mounts;
}
