/**
 * Composition root for the wallet-native control-plane surfaces
 * (ADR 0086 §5, ADR 0119).
 *
 * Four HTTP surfaces front the wallet-native libraries this repository already
 * carries as pure logic:
 *
 * - `wallet.registration` — registering a wallet-pass provider and issuing a
 *   pass whose barcode is a canonical interaction reference (`@opensesame/wallet`).
 * - `openid4vp.verifier` — asking a wallet for a presentation and binding the
 *   verified proof to an interaction's request digest (`@opensesame/openid4vp`).
 * - `openid4vci.issuer` — issuing the minimal OpenSesame credential over the
 *   pre-authorized-code grant (`@opensesame/openid4vci`).
 * - `rendezvous` — a cross-device channel that only ever carries an opaque
 *   reference from one screen to another (`@opensesame/ceremony-kit`).
 *
 * The libraries are implemented and tested; the HTTP mounts that expose them
 * are owned by sibling swarms. Until a swarm lands a real Hono sub-router for a
 * surface, this module mounts a **typed Unavailable stub** in its place. Every
 * method and every subpath under the prefix answers `501` with a
 * machine-readable body naming the capability, the reason and the ADR — never a
 * bare `404` a caller could mistake for "wrong path", and never a silent
 * success that could settle an interaction outside `approve()`'s digest
 * binding (ADR 0086 §4).
 *
 * Wiring rule for the owning swarm: land `create<surface>Routes()` in its own
 * file, then pass it into {@link mountWalletNativeRoutes} from `app.ts`:
 *
 * ```ts
 * mountWalletNativeRoutes(app, { openid4vpVerifier: createOpenid4vpRoutes() });
 * ```
 *
 * A real verifier, issuer, pass provider or rendezvous mount MUST route its
 * result back through the interaction layer — it may not settle, approve or
 * authorize anything on its own. That contract is what keeps the digest check
 * in `approve()` the single place an approval means something.
 */

import { Hono } from "hono";
import type { Variables } from "../middleware/context.js";

/** ADR that records the composition-root decision and the honest matrix. */
export const WALLET_NATIVE_ADR =
  "0119-wallet-native-control-plane-composition.md";

export type WalletNativeSurfaceId =
  | "wallet.registration"
  | "openid4vp.verifier"
  | "openid4vci.issuer"
  | "rendezvous";

/** Static description of one wallet-native surface. */
export interface WalletNativeSurface {
  readonly id: WalletNativeSurfaceId;
  readonly title: string;
  /** Route prefix, mounted at the API root. */
  readonly mountPath: string;
  /** The package that carries the pure logic behind this surface. */
  readonly library: string;
  /** Why the surface is refused until its owning swarm mounts a real router. */
  readonly unavailableReason: string;
}

export const WALLET_NATIVE_SURFACES = [
  {
    id: "wallet.registration",
    title: "Wallet-pass provider registration and pass issuance",
    mountPath: "/v1/wallet",
    library: "@opensesame/wallet",
    unavailableReason:
      "wallet-pass registration is not mounted; a pass carries an interaction reference and authorizes nothing (ADR 0086 §5)",
  },
  {
    id: "openid4vp.verifier",
    title: "OpenID4VP verifier (presentation request and verification)",
    mountPath: "/v1/openid4vp",
    library: "@opensesame/openid4vp",
    unavailableReason:
      "the OpenID4VP verifier is not mounted; a verified presentation must bind to an interaction digest, never settle one directly (ADR 0086 §4)",
  },
  {
    id: "openid4vci.issuer",
    title: "OpenID4VCI issuer (pre-authorized-code credential issuance)",
    mountPath: "/v1/openid4vci",
    library: "@opensesame/openid4vci",
    unavailableReason:
      "the OpenID4VCI issuer is not mounted; issuance is reached from an already-authenticated OpenSesame session and grants no runtime authority (ADR 0086 §7)",
  },
  {
    id: "rendezvous",
    title: "Cross-device interaction rendezvous",
    mountPath: "/v1/rendezvous",
    library: "@opensesame/ceremony-kit",
    unavailableReason:
      "the cross-device rendezvous is not mounted; it carries an opaque reference only, and a reference authorizes nothing (ADR 0086 §3)",
  },
] as const satisfies readonly WalletNativeSurface[];

/**
 * Real sub-routers, keyed by surface. A swarm that has landed a surface passes
 * its router here; every absent key falls back to a typed Unavailable stub.
 */
export interface WalletNativeMounts {
  readonly walletRegistration?: Hono<{ Variables: Variables }>;
  readonly openid4vpVerifier?: Hono<{ Variables: Variables }>;
  readonly openid4vciIssuer?: Hono<{ Variables: Variables }>;
  readonly rendezvous?: Hono<{ Variables: Variables }>;
}

export type WalletNativeState = "available" | "unavailable";

/** One row of the runtime support matrix. */
export interface WalletNativeCapability {
  readonly id: WalletNativeSurfaceId;
  readonly title: string;
  readonly mountPath: string;
  readonly library: string;
  readonly adr: string;
  readonly state: WalletNativeState;
  /** Present only when `state` is `unavailable`. */
  readonly reason?: string;
}

function mountFor(
  mounts: WalletNativeMounts,
  id: WalletNativeSurfaceId,
): Hono<{ Variables: Variables }> | undefined {
  switch (id) {
    case "wallet.registration":
      return mounts.walletRegistration;
    case "openid4vp.verifier":
      return mounts.openid4vpVerifier;
    case "openid4vci.issuer":
      return mounts.openid4vciIssuer;
    case "rendezvous":
      return mounts.rendezvous;
  }
}

/**
 * The honest support matrix, computed from what was actually wired. A surface
 * is `available` only when a real router was supplied for it; otherwise it is
 * `unavailable` and states why.
 */
export function walletNativeCapabilities(
  mounts: WalletNativeMounts = {},
): readonly WalletNativeCapability[] {
  return WALLET_NATIVE_SURFACES.map((surface) => {
    if (mountFor(mounts, surface.id) !== undefined) {
      return {
        id: surface.id,
        title: surface.title,
        mountPath: surface.mountPath,
        library: surface.library,
        adr: WALLET_NATIVE_ADR,
        state: "available",
      };
    }
    return {
      id: surface.id,
      title: surface.title,
      mountPath: surface.mountPath,
      library: surface.library,
      adr: WALLET_NATIVE_ADR,
      state: "unavailable",
      reason: surface.unavailableReason,
    };
  });
}

/**
 * A router that refuses every request under its prefix with a typed `501`.
 *
 * The wildcard covers the prefix root and every subpath, so an unmounted
 * surface cannot be probed for a working corner: there is no path that answers
 * anything but the refusal, and the refusal is the same shape on every method.
 */
function unavailableStub(
  surface: WalletNativeSurface,
): Hono<{ Variables: Variables }> {
  const stub = new Hono<{ Variables: Variables }>();
  stub.all("*", (c) =>
    c.json(
      {
        error: "capability_unavailable",
        capability: surface.id,
        reason: surface.unavailableReason,
        adr: WALLET_NATIVE_ADR,
        correlationId: c.get("correlationId"),
      },
      501,
    ),
  );
  return stub;
}

/**
 * Mount every wallet-native surface onto `app`, real where a swarm supplied a
 * router and a typed Unavailable stub everywhere else, plus the runtime support
 * matrix at `GET /v1/wallet-native/capabilities` (public, non-secret posture).
 */
export function mountWalletNativeRoutes(
  app: Hono<{ Variables: Variables }>,
  mounts: WalletNativeMounts = {},
): void {
  for (const surface of WALLET_NATIVE_SURFACES) {
    app.route(
      surface.mountPath,
      mountFor(mounts, surface.id) ?? unavailableStub(surface),
    );
  }
  // Issuer metadata and `/oid4vci/*` are specified at the credential-issuer
  // identifier, not under `/v1/openid4vci`. Mount the real router at `/` so
  // an independent client can complete issuance from discovery.
  if (mounts.openid4vciIssuer) {
    app.route("/", mounts.openid4vciIssuer);
  }
  app.get("/v1/wallet-native/capabilities", (c) =>
    c.json({ capabilities: walletNativeCapabilities(mounts) }),
  );
}
