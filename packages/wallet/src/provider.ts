/**
 * The vendor-neutral wallet boundary.
 *
 * A wallet pass is the most exposed surface OpenSesame has. It sits on a lock
 * screen, it is rendered by software we do not control, it is synchronised to
 * a vendor's cloud, and it is shown to whoever is standing next to the phone.
 * Anything that reaches it should be assumed public, permanently.
 *
 * That constraint is what this interface encodes. A provider is handed an
 * already-minted `interactionRef` and the canonical URL it addresses — never a
 * token, never a session, never the subject id behind the interaction. The
 * barcode a pass carries is an opaque reference (ADR 0086): scanning it says
 * *which question is being asked*, and answering it still costs an
 * authenticated approver and a proof bound to the request digest. So a pass
 * that leaks onto a stranger's screen costs us nothing, and that is deliberate
 * rather than lucky.
 *
 * The interface is vendor-neutral for one practical reason: Google Wallet,
 * Apple Wallet, and "no wallet at all" have wildly different provisioning
 * models, and the calling code — a gateway route, a CLI verb — must not learn
 * any of them. A caller asks for capabilities, and gets an honest answer; it
 * never branches on a provider name.
 */

import type { InteractionKind } from "@opensesame/os-domain";

/**
 * What a wallet integration can actually do, right now, with the configuration
 * it was handed.
 *
 * Reported rather than assumed. Every field here has been a source of silent
 * breakage in wallet integrations elsewhere: code assumes revocation exists,
 * ships, and then discovers that "revoked" passes stay live on the device
 * forever. A caller that needs revocation must be able to find out *before* it
 * promises a human that a pass can be taken back.
 */
export interface WalletCapabilities {
  /** Stable provider discriminator, e.g. `"google"` or `"none"`. */
  provider: string;
  /**
   * Configured, and able in principle to do its job.
   *
   * Deliberately not a liveness probe. A capabilities call that reached out to
   * the vendor would turn every vendor outage into an outage of ours, and
   * would make an already-issued, perfectly valid pass look invalid because a
   * network hiccup happened while somebody rendered a settings page.
   */
  available: boolean;
  issue: boolean;
  update: boolean;
  revoke: boolean;
  /**
   * Whether the provider will rotate the barcode payload on a timer.
   *
   * Reported honestly and, for Google Generic passes, reported as `false` —
   * see `google.ts` for why rotation is the wrong tool for a barcode that is
   * not a bearer in the first place.
   */
  rotatingBarcode: boolean;
}

/** One non-secret label/value pair rendered on the face of the pass. */
export interface WalletDisplayRow {
  label: string;
  value: string;
}

/**
 * Everything needed to mint a pass, and nothing more.
 *
 * There is no `secret`, no `token`, and no `subjectId` field, and adding one
 * would be the bug. `payload.ts` enforces that absence at runtime for every
 * pass, because an interface can only stop the mistakes that go through the
 * type checker.
 */
export interface WalletPassIssueInput {
  /** Opaque handle, already minted. Safe to print, scan, and photograph. */
  interactionRef: string;
  /** Canonical https URL the barcode resolves to. */
  interactionUrl: string;
  kind: InteractionKind;
  title: string;
  subtitle?: string;
  expiresAt: Date;
  /** Non-secret display rows only. */
  displayRows?: ReadonlyArray<WalletDisplayRow>;
}

/**
 * Lifecycle state a provider may be asked to move a pass into.
 *
 * `expired` is the terminal state used for revocation. Deleting a pass is not
 * offered: no major wallet vendor reliably removes an object from a device
 * that already holds it, so a "delete" verb would be a promise we cannot keep.
 */
export type WalletPassState = "active" | "expired";

/**
 * An update re-states the whole pass rather than patching fields.
 *
 * Notably it does *not* take a `passId`. The object id is re-derived from the
 * interaction reference by the provider, so a caller cannot aim an update at a
 * pass belonging to a different interaction — a caller-supplied object id is
 * exactly the parameter an attacker would want.
 */
export interface WalletPassUpdateInput extends WalletPassIssueInput {
  /** Defaults to `"active"`. Set `"expired"` to retire the pass. */
  state?: WalletPassState;
}

/** Revocation addresses an interaction, for the same reason updates do. */
export interface WalletPassRevokeInput {
  interactionRef: string;
}

/**
 * The result of issuing.
 *
 * `saveUrl` is the only thing a caller shows a human. It is a capability to
 * *save a pass*, not a capability to approve anything, and it expires with the
 * interaction it fronts.
 */
export interface WalletPassArtifact {
  provider: string;
  /** e.g. the Save-to-Wallet URL. */
  saveUrl: string;
  passId: string;
  expiresAt: Date;
}

export interface WalletPassProvider {
  capabilities(): WalletCapabilities;
  issuePass(input: WalletPassIssueInput): Promise<WalletPassArtifact>;
  // biome-ignore lint/suspicious/noConfusingVoidType: the union is the contract — a provider that can rebuild a save link returns the new artifact, one that only mutates server-side state returns nothing, and a caller must handle both.
  updatePass?(input: WalletPassUpdateInput): Promise<WalletPassArtifact | void>;
  revokePass?(input: WalletPassRevokeInput): Promise<void>;
}

/**
 * The wallet is not configured on this deployment.
 *
 * Typed rather than a bare `Error` so a route can map it to "wallet passes are
 * turned off here" instead of a 500. Running without a wallet is a supported
 * configuration, not a fault.
 */
export class WalletNotConfiguredError extends Error {
  readonly provider: string;
  constructor(provider: string, detail: string) {
    super(detail);
    this.name = "WalletNotConfiguredError";
    this.provider = provider;
  }
}

/**
 * Caller input that cannot be turned into a pass.
 *
 * Distinct from `WalletRequestError`: nothing was sent anywhere, and retrying
 * the same call will fail the same way. The fix is in the caller.
 */
export class WalletInputError extends Error {
  constructor(detail: string) {
    super(detail);
    this.name = "WalletInputError";
  }
}

/**
 * A vendor API call that did not succeed.
 *
 * `status` is `0` when the request never reached the vendor at all (DNS,
 * TLS, a thrown `fetch`). The distinction matters to a caller deciding whether
 * a retry is safe: a `0` means the mutation certainly did not happen, a `5xx`
 * means it might have.
 */
export class WalletRequestError extends Error {
  readonly status: number;
  constructor(status: number, detail: string, cause?: unknown) {
    super(detail, { cause });
    this.name = "WalletRequestError";
    this.status = status;
  }
}

const NULL_CAPABILITIES: WalletCapabilities = {
  provider: "none",
  available: false,
  issue: false,
  update: false,
  revoke: false,
  rotatingBarcode: false,
};

/**
 * The provider a deployment gets when no wallet vendor is configured.
 *
 * It exists so that "I have no Google service account" is a working system
 * rather than a crash on the first import. Every method refuses loudly with a
 * typed error: a null provider that quietly returned a fake artifact would be
 * far worse than no provider at all, because the caller would go on to show a
 * human a save button that leads nowhere, and the failure would surface at the
 * one moment the human is least able to do anything about it.
 */
export class NullWalletProvider implements WalletPassProvider {
  capabilities(): WalletCapabilities {
    return { ...NULL_CAPABILITIES };
  }

  issuePass(): Promise<WalletPassArtifact> {
    return Promise.reject(
      new WalletNotConfiguredError(
        "none",
        "No wallet provider is configured; a pass cannot be issued.",
      ),
    );
  }

  updatePass(): Promise<WalletPassArtifact> {
    return Promise.reject(
      new WalletNotConfiguredError(
        "none",
        "No wallet provider is configured; there is no pass to update.",
      ),
    );
  }

  revokePass(): Promise<void> {
    return Promise.reject(
      new WalletNotConfiguredError(
        "none",
        "No wallet provider is configured; there is no pass to revoke.",
      ),
    );
  }
}
