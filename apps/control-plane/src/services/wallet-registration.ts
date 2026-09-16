/**
 * The launcher-registration lifecycle service (ADR 0086).
 *
 * A launcher pass is a persistent card a person keeps that opens OpenSesame —
 * registered once, not minted per interaction. This service is the seam between
 * the vendor-neutral wallet package (`@opensesame/wallet`) and the control
 * plane's HTTP surface, and it exists to hold three rules in one place so a
 * route handler cannot get them subtly wrong:
 *
 * 1. **Registration is idempotent and owned.** Re-registering the same id for
 *    the same principal re-signs the same launcher link; a disabled
 *    registration stays disabled, and one owned by somebody else is invisible.
 * 2. **The public link never carries a seed.** Signing goes through the wallet
 *    package's public-object path; a rotating-barcode seed is only ever
 *    provisioned over the authenticated REST channel, never returned here and
 *    never put in the Save link.
 * 3. **Disablement is local first and does not depend on Google.** Turning a
 *    launcher off writes the local record and returns; expiring the Google
 *    object is a best-effort second step whose failure never un-disables the
 *    registration. A vendor outage must not be a window in which a lost
 *    device's launcher cannot be revoked.
 *
 * The provider and store are injected so the service has no ambient state and
 * is exercised in isolation. A deployment wires a configured provider and a
 * durable store; tests wire a scripted provider and the in-memory store.
 */

import type {
  WalletLauncherProvider,
  WalletRegistration,
  WalletRegistrationStore,
} from "@opensesame/wallet";
import { WalletRegistrationConflictError } from "@opensesame/wallet";

export interface WalletRegistrationServiceDeps {
  provider: WalletLauncherProvider;
  store: WalletRegistrationStore;
}

export interface RegisterLauncherInput {
  ownerPrincipalId: string;
  registrationId: string;
  header: string;
  subtitle?: string;
  /** Ask for a rotating barcode. Ignored, honestly, when unsupported. */
  rotatingBarcode?: boolean;
}

/**
 * The result of registering, as a route renders it.
 *
 * `saveUrl` is the only capability handed to a human — a link that saves a
 * launcher, authorizing nothing. `rotatingBarcodeProvisioned` reports what
 * actually happened rather than what was asked, because a provider without a
 * `fetch` cannot provision one and saying so is the honest answer.
 */
export interface RegisterLauncherResult {
  registration: WalletRegistration;
  saveUrl: string;
  reissued: boolean;
  rotatingBarcodeProvisioned: boolean;
}

/** Why a registration could not be created as asked. */
export type RegisterLauncherRefusal = "already_disabled" | "owned_by_another";

export class WalletRegistrationRefused extends Error {
  readonly reason: RegisterLauncherRefusal;
  constructor(reason: RegisterLauncherRefusal) {
    super(`wallet launcher registration refused: ${reason}`);
    this.name = "WalletRegistrationRefused";
    this.reason = reason;
  }
}

/** The outcome of a disable, separating the local fact from the vendor's. */
export interface DisableLauncherResult {
  /** The local record, now disabled. Null when there was nothing to disable. */
  registration: WalletRegistration | null;
  /**
   * Whether Google acknowledged the object's expiry.
   *
   * Informational only. `false` never means the launcher is still on — the
   * local record is what governs — it means the best-effort vendor call did
   * not land and may want retrying.
   */
  googleAcknowledged: boolean;
}

export interface WalletRegistrationService {
  register(input: RegisterLauncherInput): Promise<RegisterLauncherResult>;
  list(ownerPrincipalId: string): Promise<readonly WalletRegistration[]>;
  disable(
    ownerPrincipalId: string,
    registrationId: string,
  ): Promise<DisableLauncherResult>;
}

export function createWalletRegistrationService(
  deps: WalletRegistrationServiceDeps,
): WalletRegistrationService {
  const { provider, store } = deps;

  const issue = (input: RegisterLauncherInput) => {
    const launcherInput =
      input.subtitle === undefined
        ? { registrationId: input.registrationId, header: input.header }
        : {
            registrationId: input.registrationId,
            header: input.header,
            subtitle: input.subtitle,
          };
    return provider.issueLauncher(launcherInput);
  };

  const provisionIfAsked = async (
    input: RegisterLauncherInput,
  ): Promise<boolean> => {
    if (!input.rotatingBarcode) return false;
    if (!provider.capabilities().rotatingBarcode) return false;
    if (provider.provisionRotatingBarcode === undefined) return false;
    const launcherInput =
      input.subtitle === undefined
        ? { registrationId: input.registrationId, header: input.header }
        : {
            registrationId: input.registrationId,
            header: input.header,
            subtitle: input.subtitle,
          };
    // Called as a member, not through a detached local, so a class-based
    // provider keeps its receiver.
    await provider.provisionRotatingBarcode(launcherInput);
    return true;
  };

  return {
    async register(
      input: RegisterLauncherInput,
    ): Promise<RegisterLauncherResult> {
      const existing = await store.get(input.registrationId);
      if (existing) {
        if (existing.ownerPrincipalId !== input.ownerPrincipalId) {
          // Invisible: a caller cannot learn that an id they do not own exists.
          throw new WalletRegistrationRefused("owned_by_another");
        }
        if (existing.state === "disabled") {
          // A disabled launcher is off, and re-registering must not silently
          // turn it back on. Re-enabling is a separate, deliberate act.
          throw new WalletRegistrationRefused("already_disabled");
        }
        // Idempotent: re-sign the same (offline, cheap) link for the same id.
        const artifact = await issue(input);
        const rotatingBarcodeProvisioned = await provisionIfAsked(input);
        return {
          registration: existing,
          saveUrl: artifact.saveUrl,
          reissued: true,
          rotatingBarcodeProvisioned,
        };
      }

      // New: sign first (offline), then claim the id. A race on the same id is
      // resolved by the store's own conflict; the discarded save link cost a
      // signature, not a network call.
      const artifact = await issue(input);
      let registration: WalletRegistration;
      try {
        registration = await store.create({
          registrationId: input.registrationId,
          ownerPrincipalId: input.ownerPrincipalId,
          passId: artifact.passId,
        });
      } catch (error) {
        if (error instanceof WalletRegistrationConflictError) {
          throw new WalletRegistrationRefused("owned_by_another");
        }
        throw error;
      }
      const rotatingBarcodeProvisioned = await provisionIfAsked(input);
      return {
        registration,
        saveUrl: artifact.saveUrl,
        reissued: false,
        rotatingBarcodeProvisioned,
      };
    },

    list(ownerPrincipalId: string): Promise<readonly WalletRegistration[]> {
      return store.list(ownerPrincipalId);
    },

    async disable(
      ownerPrincipalId: string,
      registrationId: string,
    ): Promise<DisableLauncherResult> {
      const existing = await store.get(registrationId);
      // A launcher the caller does not own is one they cannot see, so it is one
      // they cannot turn off — same 404 as one that never existed.
      if (!existing || existing.ownerPrincipalId !== ownerPrincipalId) {
        return { registration: null, googleAcknowledged: false };
      }

      // Local first, and unconditionally. This is the write that turns the
      // launcher off, and it does not consult Google.
      const registration = await store.disable(registrationId);

      // Best-effort vendor expiry. Its failure is recorded, never propagated —
      // the local disablement already stands.
      let googleAcknowledged = false;
      if (provider.disableLauncher !== undefined) {
        try {
          // Member call, so a class-based provider keeps its receiver.
          await provider.disableLauncher({ registrationId });
          googleAcknowledged = true;
        } catch {
          googleAcknowledged = false;
        }
      }
      return { registration, googleAcknowledged };
    },
  };
}
