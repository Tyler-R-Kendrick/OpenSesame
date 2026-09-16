/**
 * Default composition of the ADR 0086 / ADR 0119 wallet-native surfaces.
 *
 * Each surface is either a real router or omitted (so `mountWalletNativeRoutes`
 * keeps its typed Unavailable stub). Tests may still pass an explicit
 * `walletNative: {}` to force every stub; production and ordinary
 * `createControlPlane()` calls get the mounts below.
 */

import { generateKeyPairSync } from "node:crypto";
import {
  InMemoryWalletRegistrationStore,
  createWalletLauncherProvider,
} from "@opensesame/wallet";
import { Hono } from "hono";
import type { ControlPlaneConfig } from "./config.js";
import type { Variables } from "./middleware/context.js";
import {
  DurableAccessTokenStore,
  DurableNonceStore,
  DurableOfferStore,
  DurablePreAuthorizedCodeStore,
} from "./repos/openid4vci-stores.js";
import { createOpenid4vciRoutes } from "./routes/openid4vci.js";
import { createOpenid4vpRoutes } from "./routes/openid4vp.js";
import { createRendezvousRoutes } from "./routes/rendezvous.js";
import type { WalletNativeMounts } from "./routes/wallet-native.js";
import { createWalletRegistrationRoutes } from "./routes/wallet-registration.js";

export interface ResolveWalletNativeMountsInput {
  readonly config: ControlPlaneConfig;
  readonly processEnv: NodeJS.ProcessEnv;
  readonly clock: () => Date;
  /**
   * Explicit override from `CreateControlPlaneOptions`. When provided (even as
   * `{}`), it wins entirely so suites can pin Unavailable stubs.
   */
  readonly override?: WalletNativeMounts | undefined;
}

const OPENSESAME_VCT =
  "https://credentials.opensesame.local/opensesame-holder-binding/v1";
const OPENSESAME_CREDENTIAL_CONFIGURATION_ID = "opensesame-holder-binding";

/**
 * Ephemeral ES256 PKCS8 for local/dev OID4VCI. Production deployments must
 * replace this with a configured durable issuer key before advertising the
 * issuer publicly; the flag alone is not a trust root.
 */
function ephemeralIssuerPkcs8(): Uint8Array {
  const { privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const der = privateKey.export({ type: "pkcs8", format: "der" });
  return new Uint8Array(der);
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
      store: new InMemoryWalletRegistrationStore(input.clock),
    }),
  );
  mounts.walletRegistration = walletRoot;
  mounts.rendezvous = createRendezvousRoutes();

  if (input.config.protocolFeatures.oid4vp) {
    mounts.openid4vpVerifier = createOpenid4vpRoutes({
      publicUrl: input.config.publicUrl,
      clock: input.clock,
      vct: OPENSESAME_VCT,
    });
  }

  if (input.config.protocolFeatures.oid4vci) {
    const issuer = input.config.issuer.replace(/\/$/, "");
    mounts.openid4vciIssuer = createOpenid4vciRoutes({
      issuer,
      vct: OPENSESAME_VCT,
      credentialConfigurationId: OPENSESAME_CREDENTIAL_CONFIGURATION_ID,
      signing: { key: ephemeralIssuerPkcs8(), algorithm: "ES256" },
      subjectPepper: input.config.claimPepper,
      credentialLifetimeSeconds: 86_400,
      offerTtlSeconds: 300,
      nonceTtlSeconds: 120,
      accessTokenTtlSeconds: 120,
      grants: new DurablePreAuthorizedCodeStore(new Map()),
      nonces: new DurableNonceStore(new Map(), 120),
      offers: new DurableOfferStore(new Map()),
      accessTokens: new DurableAccessTokenStore(new Map()),
      clock: input.clock,
    });
  }

  return mounts;
}
