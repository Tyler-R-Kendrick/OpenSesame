import { randomBytes, randomUUID } from "node:crypto";
import {
  type ClientClaimChallengeStore,
  ClientOriginConflictError,
  type ClientOriginStore,
} from "@opensesame/database";
import {
  type ClientRecordStore,
  SafeMetadataFetcher,
  canonicalizeOrigin,
  originClientId,
} from "@opensesame/oauth-provider";
import { overlapCast, type Clock, type JsonObject } from "@opensesame/os-domain";

/** F5: claim challenges live at most ten minutes. */
export const CLAIM_CHALLENGE_TTL_MS = 600_000;

const MAX_WELL_KNOWN_BYTES = 16_384;

export type ClaimErrorCode =
  | "not_found"
  | "client_inactive"
  | "owner_mismatch"
  | "challenge_consumed"
  | "challenge_expired"
  | "proof_fetch_failed"
  | "proof_mismatch"
  | "alias_conflict"
  | "invalid_origin";

/** Typed claim-flow failure; routes map `status`/`code` verbatim. */
export class ClaimError extends Error {
  override readonly name = "ClaimError";

  constructor(
    readonly code: ClaimErrorCode,
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export interface ClaimWellKnownDocument {
  application_id: string;
  origin: string;
  challenge: string;
  expires_at: string;
  issuer: string;
  owner_principal_id: string;
}

export interface StartedClaim {
  challengeId: string;
  challenge: string;
  wellKnownUrl: string;
  expiresAt: Date;
  document: ClaimWellKnownDocument;
}

export interface VerifiedClaim {
  applicationId: string;
  sectorIdentifier: string;
  origin: string;
  ownershipStatus: "claimed";
  aliasAttached: boolean;
}

export interface AppClaimServiceOptions {
  clientStore: ClientRecordStore;
  challengeStore: ClientClaimChallengeStore;
  clientOriginStore: ClientOriginStore;
  issuer: string;
  /** Deployment/system principal owning unclaimed origin clients (R-A). */
  systemOwnerPrincipalId: string;
  clock: Clock;
  isProduction: boolean;
  /**
   * Direct (non-pinned) proof fetch. Loopback origins cannot pass the
   * SSRF-pinned fetcher, so development claims of `http://127.0.0.1:*` sites
   * fetch directly — never in production.
   */
  allowDirectFetch: boolean;
  /** Test seam for the proof document fetch. */
  fetchImpl?: typeof fetch;
}

/**
 * F5 well-known ownership claim. A verified principal proves control of an
 * origin client's canonical origin (or an alias) by hosting
 * `/.well-known/opensesame-client.json` with a single-use challenge; a
 * successful verify *transfers* ownership from the deployment/system
 * principal to the claimant (ADR 0050 R-A) and may attach a verified alias
 * (`client_origins`) that shares the application's pairwise sector.
 */
export class AppClaimService {
  readonly #fetcher: SafeMetadataFetcher;
  readonly #fetchImpl: typeof fetch;

  constructor(private readonly options: AppClaimServiceOptions) {
    // cimdEnabled only gates the fetcher; claim proof fetch is its own feature.
    this.#fetcher = new SafeMetadataFetcher({ cimdEnabled: true });
    this.#fetchImpl = options.fetchImpl ?? fetch;
  }

  #canonicalize(origin: string): string {
    try {
      return canonicalizeOrigin(origin, {
        allowLoopbackHttp: true,
        production: this.options.isProduction,
      });
    } catch (err) {
      throw new ClaimError(
        "invalid_origin",
        400,
        err instanceof Error ? err.message : "Origin is not canonicalizable",
      );
    }
  }

  /**
   * Load an origin-profile client the caller may legitimately claim: it must
   * be unclaimed (system-owned) or already theirs. Foreign, unknown, and
   * non-origin ids all answer not_found so the flow is not an existence
   * oracle for other principals' clients.
   */
  async #loadClaimable(applicationId: string, ownerPrincipalId: string) {
    const client = await this.options.clientStore.findById(applicationId);
    if (
      !client ||
      client.admissionMode !== "origin_profile" ||
      (client.ownerPrincipalId !== this.options.systemOwnerPrincipalId &&
        client.ownerPrincipalId !== ownerPrincipalId)
    ) {
      throw new ClaimError("not_found", 404, "Application not found");
    }
    return client;
  }

  async startClaim(input: {
    applicationId: string;
    ownerPrincipalId: string;
    /** Alias origin to claim; defaults to the client's canonical origin. */
    origin?: string;
  }): Promise<StartedClaim> {
    const client = await this.#loadClaimable(
      input.applicationId,
      input.ownerPrincipalId,
    );
    if (client.state !== "active") {
      throw new ClaimError(
        "client_inactive",
        409,
        `Application is ${client.state}`,
      );
    }
    const canonical = this.#canonicalize(input.origin ?? client.origin ?? "");

    const challenge = randomBytes(32).toString("base64url");
    const expiresAt = new Date(
      this.options.clock().getTime() + CLAIM_CHALLENGE_TTL_MS,
    );
    const id = `clc_${randomUUID()}`;
    await this.options.challengeStore.insert({
      id,
      applicationId: client.id,
      ownerPrincipalId: input.ownerPrincipalId,
      challenge,
      expiresAt,
    });

    return {
      challengeId: id,
      challenge,
      wellKnownUrl: `${canonical}/.well-known/opensesame-client.json`,
      expiresAt,
      document: {
        application_id: client.id,
        origin: canonical,
        challenge,
        expires_at: expiresAt.toISOString(),
        issuer: this.options.issuer,
        owner_principal_id: input.ownerPrincipalId,
      },
    };
  }

  async #fetchProof(wellKnown: string): Promise<JsonObject> {
    let text: string;
    if (this.options.allowDirectFetch) {
      let res: Response;
      try {
        res = await this.#fetchImpl(wellKnown, {
          redirect: "error",
          headers: { accept: "application/json" },
          signal: AbortSignal.timeout(5_000),
        });
      } catch {
        throw new ClaimError(
          "proof_fetch_failed",
          400,
          "Well-known document fetch failed",
        );
      }
      if (!res.ok) {
        throw new ClaimError(
          "proof_fetch_failed",
          400,
          `Well-known document fetch failed: HTTP ${res.status}`,
        );
      }
      text = await res.text();
    } else {
      let result: Awaited<ReturnType<SafeMetadataFetcher["fetch"]>>;
      try {
        result = await this.#fetcher.fetch(wellKnown);
      } catch (err) {
        throw new ClaimError(
          "proof_fetch_failed",
          400,
          err instanceof Error ? err.message : "Well-known fetch failed",
        );
      }
      text = result.body;
    }
    if (text.length > MAX_WELL_KNOWN_BYTES) {
      throw new ClaimError(
        "proof_fetch_failed",
        400,
        "Well-known document exceeds 16KiB",
      );
    }
    try {
      return overlapCast(JSON.parse(text));
    } catch {
      throw new ClaimError(
        "proof_fetch_failed",
        400,
        "Well-known document is not JSON",
      );
    }
  }

  async verifyAndClaim(input: {
    challenge: string;
    ownerPrincipalId: string;
    /** Origin the document was hosted at; defaults to the client's origin. */
    origin?: string;
    /** Attach the verified origin as an alias even when canonical. */
    attachAlias?: boolean;
  }): Promise<VerifiedClaim> {
    const { challengeStore, clientStore, clientOriginStore } = this.options;
    const row = await challengeStore.findByChallenge(input.challenge);
    if (!row) {
      throw new ClaimError("not_found", 404, "Claim challenge not found");
    }
    if (row.ownerPrincipalId !== input.ownerPrincipalId) {
      throw new ClaimError(
        "owner_mismatch",
        403,
        "Claim challenge belongs to another principal",
      );
    }
    if (row.consumedAt) {
      throw new ClaimError(
        "challenge_consumed",
        409,
        "Claim challenge was already consumed",
      );
    }
    const now = this.options.clock();
    if (row.expiresAt.getTime() <= now.getTime()) {
      throw new ClaimError(
        "challenge_expired",
        410,
        "Claim challenge has expired",
      );
    }

    const client = await this.#loadClaimable(
      row.applicationId,
      input.ownerPrincipalId,
    );
    if (client.state !== "active") {
      throw new ClaimError(
        "client_inactive",
        409,
        `Application is ${client.state}`,
      );
    }
    const canonical = this.#canonicalize(input.origin ?? client.origin ?? "");

    const doc = await this.#fetchProof(
      `${canonical}/.well-known/opensesame-client.json`,
    );
    if (
      doc.challenge !== row.challenge ||
      doc.application_id !== client.id ||
      doc.origin !== canonical ||
      doc.issuer !== this.options.issuer ||
      doc.owner_principal_id !== input.ownerPrincipalId
    ) {
      throw new ClaimError(
        "proof_mismatch",
        400,
        "Well-known document does not match the claim challenge",
      );
    }

    const alias = input.attachAlias === true || canonical !== client.origin;
    if (alias) {
      // Detect cross-application alias conflicts before the challenge is
      // spent: a conflicted attach must not burn the single-use challenge.
      const existing = await clientOriginStore.findByOrigin(canonical);
      if (existing && existing.applicationId !== client.id) {
        throw new ClaimError(
          "alias_conflict",
          409,
          `Origin ${canonical} is already attached to another application`,
        );
      }
    }

    // Single-use: the conditional consume decides concurrent verifiers. A
    // replay or a lost race gets nothing back and ownership never moves twice.
    const consumed = await challengeStore.consume(input.challenge, now);
    if (!consumed) {
      throw new ClaimError(
        "challenge_consumed",
        409,
        "Claim challenge was already consumed",
      );
    }

    // R-A: claiming transfers ownership from the system principal to the
    // claiming verified principal.
    const updated = await clientStore.update({
      ...client,
      ownerPrincipalId: input.ownerPrincipalId,
      ownershipStatus: "claimed",
      claimedAt: now,
      updatedAt: now,
    });

    if (alias) {
      try {
        await clientOriginStore.insert({
          id: `cor_${randomUUID()}`,
          applicationId: client.id,
          canonicalOrigin: canonical,
          publicClientId: originClientId(canonical),
          verificationMethod: "well-known",
          status: "active",
        });
      } catch (err) {
        if (err instanceof ClientOriginConflictError) {
          throw new ClaimError("alias_conflict", 409, err.message);
        }
        throw err;
      }
    }

    return {
      applicationId: updated.id,
      sectorIdentifier: updated.sectorIdentifier,
      origin: canonical,
      ownershipStatus: "claimed",
      aliasAttached: alias,
    };
  }
}
