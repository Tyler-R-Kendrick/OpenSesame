import { randomBytes, randomUUID } from "node:crypto";
import type { Named } from "@gdp-ts/core";
import {
  type ClientClaimChallengeStore,
  ClientOriginConflictError,
  type ClientOriginStore,
} from "@opensesame/database";
import {
  type ClientRecordStore,
  canonicalizeOrigin,
  originClientId,
} from "@opensesame/oauth-provider";
import {
  type BoundaryValue,
  type Clock,
  type JsonObject,
  isJsonObject,
  overlapCast,
} from "@opensesame/os-domain";
import type { ActorId } from "../lib/ids.js";
import type { VerifiedPrincipal } from "../proofs/verified-principal.js";
import { serializeKeyed } from "../serialize.js";
import { guardedFetch } from "./guarded-fetch.js";

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

export type ClaimErrorStatus = 400 | 403 | 404 | 409 | 410;

/** Typed claim-flow failure; routes map `status`/`code` verbatim. */
export class ClaimError extends Error {
  override readonly name = "ClaimError";

  constructor(
    readonly code: ClaimErrorCode,
    readonly status: ClaimErrorStatus,
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
   * Direct fetch is limited to the literal loopback hosts under dev defaults;
   * every other destination — in every environment — goes through the
   * DNS-pinned guarded fetch.
   */
  allowDirectFetch: boolean;
  /** Server-side logging seam for fetch failures. */
  onFetchFailure?: ((detail: unknown) => void) | undefined;
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
  readonly #fetchImpl: typeof fetch;
  /** Process-local serialization for the consume-and-transfer section. */
  readonly #locks = new Map<string, Promise<void>>();

  constructor(private readonly options: AppClaimServiceOptions) {
    this.#fetchImpl = options.fetchImpl ?? fetch;
  }

  #canonicalize(origin: string): string {
    let canonical: string;
    try {
      canonical = canonicalizeOrigin(origin, {
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
    // A public claim needs a registrable multi-label host. A single label
    // (`https://com`) names a public suffix, not a site its claimant owns.
    const host = new URL(canonical).hostname.toLowerCase();
    const loopback = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);
    if (!host.includes(".") && !loopback.has(host)) {
      throw new ClaimError(
        "invalid_origin",
        400,
        "Claim origin must name a multi-label host",
      );
    }
    return canonical;
  }

  /**
   * The claim must prove an origin this application is actually allowed to
   * use. A caller cannot take over `origin:https://victim.example` by hosting
   * its challenge at an unrelated origin: for a system-owned client the
   * canonical origin must match the client, and any other origin must already
   * be a verified alias of this application.
   */
  async #assertOriginBound(
    client: {
      id: string;
      origin?: string | undefined;
      ownerPrincipalId?: string | undefined;
    },
    canonical: string,
  ): Promise<void> {
    if (canonical === client.origin) return;
    // A system-owned (unclaimed) client can only be taken by proving its own
    // canonical origin. Letting a caller pick an unrelated origin was the
    // ownership hijack: it transferred `origin:https://victim.example` to
    // whoever could host a challenge at `https://attacker.example`.
    if (client.ownerPrincipalId === this.options.systemOwnerPrincipalId) {
      throw new ClaimError(
        "proof_mismatch",
        400,
        "Claim must prove the application's canonical origin",
      );
    }
    // An application already owned by the caller may attach a new alias; the
    // ownership check above (and the alias-conflict fences below) decide
    // whether that origin is available.
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

  /**
   * Claiming transfers ownership to `owner`, so it demands the proof that
   * `owner` is a verified principal (ADR 0178): the route's check and this
   * operation can no longer drift apart.
   */
  async startClaim<A>(
    owner: Named<A, ActorId>,
    _proof: VerifiedPrincipal<A>,
    input: {
      applicationId: string;
      /** Alias origin to claim; defaults to the client's canonical origin. */
      origin?: string;
    },
  ): Promise<StartedClaim> {
    const client = await this.#loadClaimable(input.applicationId, owner.value);
    if (client.state !== "active") {
      throw new ClaimError(
        "client_inactive",
        409,
        `Application is ${client.state}`,
      );
    }
    const canonical = this.#canonicalize(input.origin ?? client.origin ?? "");
    await this.#assertOriginBound(client, canonical);

    const challenge = randomBytes(32).toString("base64url");
    const expiresAt = new Date(
      this.options.clock().getTime() + CLAIM_CHALLENGE_TTL_MS,
    );
    const id = `clc_${randomUUID()}`;
    await this.options.challengeStore.insert({
      id,
      applicationId: client.id,
      ownerPrincipalId: owner.value,
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
        owner_principal_id: owner.value,
      },
    };
  }

  async #fetchProof(wellKnown: string): Promise<JsonObject> {
    let text: string;
    const host = (() => {
      try {
        return new URL(wellKnown).hostname.replace(/^\[|\]$/gu, "");
      } catch {
        throw new ClaimError(
          "proof_fetch_failed",
          400,
          "Well-known document could not be verified",
        );
      }
    })();
    const literalLoopback = new Set(["localhost", "127.0.0.1", "::1"]).has(
      host,
    );
    if (this.options.allowDirectFetch && literalLoopback) {
      let res: Response;
      try {
        res = await this.#fetchImpl(wellKnown, {
          redirect: "error",
          headers: { accept: "application/json" },
          signal: AbortSignal.timeout(5_000),
        });
      } catch (err) {
        this.options.onFetchFailure?.(err);
        throw new ClaimError(
          "proof_fetch_failed",
          400,
          "Well-known document could not be verified",
        );
      }
      if (!res.ok) {
        this.options.onFetchFailure?.(`HTTP ${res.status}`);
        throw new ClaimError(
          "proof_fetch_failed",
          400,
          "Well-known document could not be verified",
        );
      }
      text = await res.text();
    } else {
      let result: Response;
      try {
        // Every environment uses the DNS-pinned, redirect-refusing fetch.
        // `blockPrivateHosts` is on even under dev defaults unless this is the
        // literal loopback path above: a development stack may host the claim
        // document on 127.0.0.1, but a public name that resolves into private
        // space is never a legitimate claim proof.
        result = await guardedFetch(wellKnown, true, {
          headers: { accept: "application/json" },
          signal: AbortSignal.timeout(5_000),
          maxBytes: MAX_WELL_KNOWN_BYTES,
        });
      } catch (err) {
        this.options.onFetchFailure?.(err);
        throw new ClaimError(
          "proof_fetch_failed",
          400,
          "Well-known document could not be verified",
        );
      }
      if (!result.ok) {
        this.options.onFetchFailure?.(`HTTP ${result.status}`);
        throw new ClaimError(
          "proof_fetch_failed",
          400,
          "Well-known document could not be verified",
        );
      }
      text = await result.text();
    }
    if (text.length > MAX_WELL_KNOWN_BYTES) {
      throw new ClaimError(
        "proof_fetch_failed",
        400,
        "Well-known document could not be verified",
      );
    }
    let parsed: BoundaryValue;
    try {
      parsed = overlapCast(JSON.parse(text));
    } catch {
      throw new ClaimError(
        "proof_fetch_failed",
        400,
        "Well-known document could not be verified",
      );
    }
    if (!isJsonObject(parsed)) {
      throw new ClaimError(
        "proof_fetch_failed",
        400,
        "Well-known document could not be verified",
      );
    }
    return parsed;
  }

  async verifyAndClaim<A>(
    owner: Named<A, ActorId>,
    _proof: VerifiedPrincipal<A>,
    input: {
      challenge: string;
      /** Origin the document was hosted at; defaults to the client's origin. */
      origin?: string;
      /** Attach the verified origin as an alias even when canonical. */
      attachAlias?: boolean;
    },
  ): Promise<VerifiedClaim> {
    const { challengeStore, clientStore, clientOriginStore } = this.options;
    const row = await challengeStore.findByChallenge(input.challenge);
    if (!row) {
      throw new ClaimError("not_found", 404, "Claim challenge not found");
    }
    if (row.ownerPrincipalId !== owner.value) {
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

    const client = await this.#loadClaimable(row.applicationId, owner.value);
    if (client.state !== "active") {
      throw new ClaimError(
        "client_inactive",
        409,
        `Application is ${client.state}`,
      );
    }
    const canonical = this.#canonicalize(input.origin ?? client.origin ?? "");
    await this.#assertOriginBound(client, canonical);

    const doc = await this.#fetchProof(
      `${canonical}/.well-known/opensesame-client.json`,
    );
    if (
      doc.challenge !== row.challenge ||
      doc.application_id !== client.id ||
      doc.origin !== canonical ||
      doc.issuer !== this.options.issuer ||
      doc.owner_principal_id !== owner.value
    ) {
      throw new ClaimError(
        "proof_mismatch",
        400,
        "Well-known document does not match the claim challenge",
      );
    }

    const alias = input.attachAlias === true || canonical !== client.origin;
    if (alias) {
      // An origin that is another application's canonical origin is already
      // owned through `oauth_clients.origin`; the alias table does not hold
      // that row, so check both fences before the challenge is spent.
      const canonicalOwner = await clientStore.findByOrigin(canonical);
      if (canonicalOwner && canonicalOwner.id !== client.id) {
        throw new ClaimError(
          "alias_conflict",
          409,
          `Origin ${canonical} is already the origin of another application`,
        );
      }
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
    // The ownership transfer and alias insert share the same serialized
    // section so a partial failure cannot leave an alias on a client whose
    // ownership moved elsewhere.
    return serializeKeyed(this.#locks, `app-claim:${client.id}`, async () => {
      const fresh = await this.#loadClaimable(row.applicationId, owner.value);
      if (fresh.state !== "active") {
        throw new ClaimError(
          "client_inactive",
          409,
          `Application is ${fresh.state}`,
        );
      }
      await this.#assertOriginBound(fresh, canonical);

      // Re-check the alias fences now that the lock is held; another claim
      // may have attached this origin while this request fetched the proof.
      if (alias) {
        const canonicalOwner = await clientStore.findByOrigin(canonical);
        if (canonicalOwner && canonicalOwner.id !== fresh.id) {
          throw new ClaimError(
            "alias_conflict",
            409,
            `Origin ${canonical} is already the origin of another application`,
          );
        }
        const existing = await clientOriginStore.findByOrigin(canonical);
        if (existing && existing.applicationId !== fresh.id) {
          throw new ClaimError(
            "alias_conflict",
            409,
            `Origin ${canonical} is already attached to another application`,
          );
        }
      }

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
        ...fresh,
        ownerPrincipalId: owner.value,
        ownershipStatus: "claimed",
        claimedAt: now,
      });

      if (alias) {
        try {
          await clientOriginStore.insert({
            id: `cor_${randomUUID()}`,
            applicationId: fresh.id,
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
    });
  }
}
