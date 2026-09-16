/**
 * The persistent launcher pass provider (ADR 0086).
 *
 * Where `google.ts` mints a per-interaction "address" pass that lapses with the
 * question it fronts, this mints the durable launcher a person keeps: signed
 * once into a Save-to-Wallet link, carrying a static barcode that opens
 * OpenSesame and authorizes nothing. The two modes are separate providers on
 * purpose (see `registration.ts`).
 *
 * The security-critical seam here is the rotating barcode. Google's rotating
 * barcode needs a shared TOTP seed provisioned to Google; that seed is a
 * secret, and it must **never** be signed into a Save JWT, because a Save JWT
 * is public. So:
 *
 * - `issueLauncher` signs only the public object (`buildLauncherPublicObject`),
 *   which has no field a seed could sit in, and the object is screened by both
 *   `assertLauncherPublicSafe` and the client's own gate before signing.
 * - `provisionRotatingBarcode` generates the seed, ensures the object exists
 *   server-side (screened insert), and attaches the seed over the authenticated
 *   REST channel with `patchGenericObjectUnscreened` — the one path that does
 *   not run the device-facing gate, because the seed legitimately fails it.
 *
 * Local disablement is not here: turning a registration off on this device is a
 * fact this deployment owns and must be able to assert whether or not Google is
 * reachable (see `registry.ts`). `disableLauncher` only does the best-effort
 * Google side — expiring the object — and a caller runs it after it has already
 * recorded the local disablement.
 */

import { randomBytes } from "node:crypto";
import { overlapCast } from "@opensesame/os-domain";
import {
  type GoogleWalletConfig,
  type WalletEnvSource,
  parseGoogleWalletConfig,
} from "./config.js";
import {
  type GoogleClientOptions,
  createGoogleClient,
} from "./google-client.js";
import { WalletNotConfiguredError } from "./provider.js";
import {
  type RotatingBarcodeSeed,
  type WalletLauncherInput,
  buildLauncherProvisioningObject,
  buildLauncherPublicObject,
  launcherObjectId,
} from "./registration.js";

const PROVIDER = "google";

/** RFC 4648 base32 alphabet, for a TOTP seed a person never sees. */
const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

/**
 * A fresh rotating-barcode seed.
 *
 * Twenty random bytes is the RFC 6238 recommendation for an SHA-1 TOTP secret.
 * The result is base32 with no padding — the encoding Google's provisioning
 * accepts and the shape that keeps the value out of any code path that would
 * try to treat it as text. It is generated at the moment of provisioning and
 * handed straight to the REST channel; nothing here retains it.
 */
export function newRotatingBarcodeSeed(
  byteLength = 20,
  valueLength = 6,
): RotatingBarcodeSeed {
  return { key: base32(randomBytes(byteLength)), valueLength };
}

function base32(bytes: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

/**
 * What a launcher provider can do, right now, with the configuration it holds.
 *
 * `rotatingBarcode` here means "can provision a rotating barcode", not the
 * interaction adapter's honest report that it will not rotate — a different
 * question, so a different type. Both provisioning and disablement need a
 * `fetch`; signing the launcher link does not.
 */
export interface WalletLauncherCapabilities {
  provider: string;
  available: boolean;
  issue: boolean;
  rotatingBarcode: boolean;
  disable: boolean;
}

/** The Save link and object id for a launcher. No expiry: it is persistent. */
export interface WalletLauncherArtifact {
  provider: string;
  saveUrl: string;
  passId: string;
}

export interface WalletLauncherProvider {
  capabilities(): WalletLauncherCapabilities;
  /** Sign the persistent launcher Save link. Offline; carries no seed. */
  issueLauncher(input: WalletLauncherInput): Promise<WalletLauncherArtifact>;
  /**
   * Provision a rotating barcode for an already-issued launcher.
   *
   * Generates a seed and sends it to Google. Returns nothing: the seed is
   * server-side by design, and a provider that handed it back would invite a
   * caller to store or log it.
   */
  provisionRotatingBarcode?(input: WalletLauncherInput): Promise<void>;
  /** Best-effort Google-side disablement: expire the object. */
  disableLauncher?(input: { registrationId: string }): Promise<void>;
}

const NULL_CAPABILITIES: WalletLauncherCapabilities = {
  provider: "none",
  available: false,
  issue: false,
  rotatingBarcode: false,
  disable: false,
};

/**
 * The launcher provider a deployment gets when no wallet vendor is configured.
 *
 * Refuses loudly, for the same reason `NullWalletProvider` does: a launcher
 * link to nowhere would be discovered by a human tapping a dead card.
 */
export class NullLauncherProvider implements WalletLauncherProvider {
  capabilities(): WalletLauncherCapabilities {
    return { ...NULL_CAPABILITIES };
  }

  issueLauncher(): Promise<WalletLauncherArtifact> {
    return Promise.reject(
      new WalletNotConfiguredError(
        "none",
        "No wallet provider is configured; a launcher pass cannot be issued.",
      ),
    );
  }
}

/**
 * Create a Google launcher provider bound to one issuer configuration.
 *
 * Shares the signing and REST plumbing with the interaction adapter through
 * `createGoogleClient`, so the two cannot drift on the code that mints
 * Google-trusted artifacts.
 */
export function createGoogleLauncherProvider(
  options: GoogleClientOptions,
): WalletLauncherProvider {
  const { config } = options;
  const client = createGoogleClient(options);

  return {
    capabilities(): WalletLauncherCapabilities {
      return {
        provider: PROVIDER,
        available: true,
        issue: true,
        rotatingBarcode: client.hasFetch,
        disable: client.hasFetch,
      };
    },

    async issueLauncher(
      input: WalletLauncherInput,
    ): Promise<WalletLauncherArtifact> {
      const object = buildLauncherPublicObject(config, input);
      const saveUrl = await client.signSaveUrl([overlapCast(object)]);
      return { provider: PROVIDER, saveUrl, passId: object.id };
    },

    async provisionRotatingBarcode(input: WalletLauncherInput): Promise<void> {
      // The object must exist server-side before it can grow a rotating
      // barcode. This is the public object — no seed — and it is screened by
      // the client on the way out.
      const publicObject = buildLauncherPublicObject(config, input);
      await client.insertGenericObject(overlapCast(publicObject));

      const seed = newRotatingBarcodeSeed();
      const provisioning = buildLauncherProvisioningObject(config, input, seed);
      const rotating = provisioning.rotatingBarcode;
      if (rotating === undefined) return;
      // The seed rides the unscreened path: it is ours, it goes to Google over
      // the authenticated channel, and it is the one thing the device-facing
      // gate would (correctly) refuse. Everything else was screened above.
      await client.patchGenericObjectUnscreened(
        provisioning.id,
        overlapCast({ rotatingBarcode: rotating }),
      );
    },

    async disableLauncher(input: {
      registrationId: string;
    }): Promise<void> {
      // `EXPIRED`, never delete — Google cannot pull an object off a device
      // that holds it, so expiry is the strongest truthful statement. The
      // local record is what actually turns the launcher off (registry.ts);
      // this is the best-effort Google half.
      await client.patchGenericObject(
        launcherObjectId(config, input.registrationId),
        overlapCast({ state: "EXPIRED" }),
      );
    },
  };
}

/**
 * The launcher provider a deployment should use, given its environment.
 *
 * Mirrors `createWalletProvider`: a fully-configured environment yields the
 * Google provider, an empty one yields the null provider, and a half-configured
 * one throws at startup rather than at the door.
 */
export function createWalletLauncherProvider(
  env: WalletEnvSource,
): WalletLauncherProvider {
  const config: GoogleWalletConfig = parseGoogleWalletConfig(env);
  if (!config.enabled) return new NullLauncherProvider();
  return createGoogleLauncherProvider({ config });
}
