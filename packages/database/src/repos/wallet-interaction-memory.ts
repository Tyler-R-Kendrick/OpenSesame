/**
 * In-memory wallet-adjacent interaction repositories (ADR 0086).
 */

import { ConflictError, NotFoundError, type UnitOfWork } from "./interfaces.js";
import {
  cloneProofAttempt,
  cloneReservation,
  cloneWalletRegistration,
  digestKey,
} from "./wallet-interaction-memory-clone.js";
import type {
  ExecutionReservation,
  ExecutionReservationRepository,
  InteractionProofAttempt,
  InteractionProofAttemptRepository,
  WalletRegistration,
  WalletRegistrationRepository,
} from "./wallet-interaction-types.js";

export type MemoryWalletApply = (
  uow: UnitOfWork | undefined,
  apply: () => void,
) => void;

export class MemoryWalletInteractionRepos {
  #attempts = new Map<string, InteractionProofAttempt>();
  #byDigest = new Map<string, string>();
  #registrations = new Map<string, WalletRegistration>();
  #reservations = new Map<string, ExecutionReservation>();
  readonly #apply: MemoryWalletApply;

  constructor(apply: MemoryWalletApply) {
    this.#apply = apply;
  }

  readonly interactionProofAttempts: InteractionProofAttemptRepository = {
    record: async (attempt, uow) => {
      if (this.#attempts.has(attempt.id)) {
        throw new ConflictError(`proof attempt already exists: ${attempt.id}`);
      }
      // Mirrors the global unique index on the input digest: the same proof,
      // on any interaction, is answerable once. Checked synchronously so a
      // memory store cannot green-light a replay the database would reject.
      const key = digestKey(attempt.proofInputDigest);
      if (this.#byDigest.has(key)) {
        throw new ConflictError(
          `proof input already recorded: ${attempt.interactionId}`,
        );
      }
      // Mirrors the partial unique index on accepted rows: one finalization
      // per interaction. A second good proof collides here, not at execution.
      if (
        attempt.outcome === "accepted" &&
        [...this.#attempts.values()].some(
          (row) =>
            row.interactionId === attempt.interactionId &&
            row.outcome === "accepted",
        )
      ) {
        throw new ConflictError(
          `interaction already finalized: ${attempt.interactionId}`,
        );
      }
      const row = cloneProofAttempt(attempt);
      const apply = () => {
        this.#attempts.set(row.id, cloneProofAttempt(row));
        this.#byDigest.set(key, row.id);
      };
      this.#apply(uow, apply);
      return cloneProofAttempt(row);
    },

    getById: async (id) => {
      const row = this.#attempts.get(id);
      return row ? cloneProofAttempt(row) : null;
    },

    getAcceptedForInteraction: async (interactionId) => {
      for (const row of this.#attempts.values()) {
        if (row.interactionId === interactionId && row.outcome === "accepted") {
          return cloneProofAttempt(row);
        }
      }
      return null;
    },

    findByProofInputDigest: async (digest) => {
      const id = this.#byDigest.get(digestKey(digest));
      if (!id) return null;
      const row = this.#attempts.get(id);
      return row ? cloneProofAttempt(row) : null;
    },

    countRecentForInteraction: async (interactionId, since) => {
      let n = 0;
      for (const row of this.#attempts.values()) {
        if (
          row.interactionId === interactionId &&
          row.createdAt.getTime() >= since.getTime()
        ) {
          n += 1;
        }
      }
      return n;
    },
  };

  readonly walletRegistrations: WalletRegistrationRepository = {
    register: async (registration, uow) => {
      if (this.#registrations.has(registration.id)) {
        throw new ConflictError(
          `wallet registration already exists: ${registration.id}`,
        );
      }
      // Mirrors the two partial unique indexes: one active pass per provider
      // per subject, and one active registration per provider object.
      if (registration.status === "active") {
        for (const row of this.#registrations.values()) {
          if (row.status !== "active" || row.provider !== registration.provider)
            continue;
          if (
            row.subjectKind === registration.subjectKind &&
            row.subjectId === registration.subjectId
          ) {
            throw new ConflictError(
              `wallet registration already live for subject: ${registration.provider}/${registration.subjectKind}/${registration.subjectId}`,
            );
          }
          if (row.providerObjectRef === registration.providerObjectRef) {
            throw new ConflictError(
              `wallet registration already live for object: ${registration.provider}/${registration.providerObjectRef}`,
            );
          }
        }
      }
      const row = cloneWalletRegistration(registration);
      const apply = () => {
        this.#registrations.set(row.id, cloneWalletRegistration(row));
      };
      this.#apply(uow, apply);
      return cloneWalletRegistration(row);
    },

    getById: async (id) => {
      const row = this.#registrations.get(id);
      return row ? cloneWalletRegistration(row) : null;
    },

    findActiveBySubject: async (provider, subjectKind, subjectId) => {
      for (const row of this.#registrations.values()) {
        if (
          row.status === "active" &&
          row.provider === provider &&
          row.subjectKind === subjectKind &&
          row.subjectId === subjectId
        ) {
          return cloneWalletRegistration(row);
        }
      }
      return null;
    },

    findActiveByObjectRef: async (provider, providerObjectRef) => {
      for (const row of this.#registrations.values()) {
        if (
          row.status === "active" &&
          row.provider === provider &&
          row.providerObjectRef === providerObjectRef
        ) {
          return cloneWalletRegistration(row);
        }
      }
      return null;
    },

    listForApprover: async (principalId) => {
      return [...this.#registrations.values()]
        .filter((row) => row.approverPrincipalId === principalId)
        .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
        .map(cloneWalletRegistration);
    },

    updateWithVersion: async (id, expectedVersion, patch, uow) => {
      const current = this.#registrations.get(id);
      if (!current) {
        throw new NotFoundError(`wallet registration not found: ${id}`);
      }
      if (current.version !== expectedVersion) {
        throw new ConflictError(
          `wallet registration version conflict: expected ${expectedVersion}, got ${current.version}`,
        );
      }
      const merged: WalletRegistration = {
        ...current,
        version: current.version + 1,
        updatedAt: new Date(),
      };
      if (patch.status !== undefined) merged.status = patch.status;
      if (patch.revokedAt !== undefined) merged.revokedAt = patch.revokedAt;
      if (patch.expiresAt !== undefined) merged.expiresAt = patch.expiresAt;
      if (patch.providerObjectRef !== undefined) {
        merged.providerObjectRef = patch.providerObjectRef;
      }
      const apply = () => {
        this.#registrations.set(id, cloneWalletRegistration(merged));
      };
      this.#apply(uow, apply);
      return cloneWalletRegistration(merged);
    },

    expireDue: async (now) => {
      let expired = 0;
      for (const [id, row] of this.#registrations) {
        if (
          row.status === "active" &&
          row.expiresAt !== undefined &&
          row.expiresAt.getTime() <= now.getTime()
        ) {
          this.#registrations.set(id, {
            ...row,
            status: "expired",
            updatedAt: now,
          });
          expired += 1;
        }
      }
      return expired;
    },
  };

  readonly executionReservations: ExecutionReservationRepository = {
    acquire: async (input, uow) => {
      const existing = [...this.#reservations.values()].filter(
        (row) => row.interactionId === input.interactionId,
      );
      // A committed reservation means the operation already fired; refuse.
      if (existing.some((row) => row.status === "committed")) {
        throw new ConflictError(
          `interaction already executed: ${input.interactionId}`,
        );
      }
      const maxToken = existing.reduce(
        (max, row) => Math.max(max, row.fencingToken),
        0,
      );
      const now = new Date();
      const row: ExecutionReservation = {
        id: input.id,
        interactionId: input.interactionId,
        requestDigest: input.requestDigest,
        fencingToken: maxToken + 1,
        holderRef: input.holderRef,
        status: "held",
        leaseExpiresAt: input.leaseExpiresAt,
        createdAt: now,
        updatedAt: now,
        version: 1,
      };
      const apply = () => {
        this.#reservations.set(row.id, cloneReservation(row));
      };
      this.#apply(uow, apply);
      return cloneReservation(row);
    },

    getById: async (id) => {
      const row = this.#reservations.get(id);
      return row ? cloneReservation(row) : null;
    },

    getCurrent: async (interactionId) => {
      let current: ExecutionReservation | undefined;
      for (const row of this.#reservations.values()) {
        if (row.interactionId !== interactionId || row.status !== "held")
          continue;
        if (!current || row.fencingToken > current.fencingToken) current = row;
      }
      return current ? cloneReservation(current) : null;
    },

    commit: async (id, expectedFencingToken, at, uow) => {
      const current = this.#reservations.get(id);
      if (!current) {
        throw new NotFoundError(`reservation not found: ${id}`);
      }
      const highestToken = [...this.#reservations.values()].reduce(
        (max, row) =>
          row.interactionId === current.interactionId
            ? Math.max(max, row.fencingToken)
            : max,
        0,
      );
      const committedExists = [...this.#reservations.values()].some(
        (row) =>
          row.interactionId === current.interactionId &&
          row.status === "committed",
      );
      // The fence: only the current highest token, still held, unexpired, with
      // no committed sibling, may commit. Anything else was fenced or spent.
      if (
        current.status !== "held" ||
        current.fencingToken !== expectedFencingToken ||
        current.fencingToken < highestToken ||
        current.leaseExpiresAt.getTime() < at.getTime() ||
        committedExists
      ) {
        throw new ConflictError(
          `reservation fenced or not committable: ${id} (status ${current.status}, token ${current.fencingToken})`,
        );
      }
      const merged: ExecutionReservation = {
        ...current,
        status: "committed",
        committedAt: at,
        updatedAt: at,
        version: current.version + 1,
      };
      const apply = () => {
        this.#reservations.set(id, cloneReservation(merged));
      };
      this.#apply(uow, apply);
      return cloneReservation(merged);
    },

    release: async (id, at, uow) => {
      const current = this.#reservations.get(id);
      if (!current) {
        throw new NotFoundError(`reservation not found: ${id}`);
      }
      if (current.status !== "held") {
        throw new ConflictError(
          `reservation not releasable: ${id} (status ${current.status})`,
        );
      }
      const merged: ExecutionReservation = {
        ...current,
        status: "released",
        releasedAt: at,
        updatedAt: at,
        version: current.version + 1,
      };
      const apply = () => {
        this.#reservations.set(id, cloneReservation(merged));
      };
      this.#apply(uow, apply);
      return cloneReservation(merged);
    },

    expireDue: async (now) => {
      let expired = 0;
      for (const [id, row] of this.#reservations) {
        if (
          row.status === "held" &&
          row.leaseExpiresAt.getTime() <= now.getTime()
        ) {
          this.#reservations.set(id, {
            ...row,
            status: "expired",
            updatedAt: now,
          });
          expired += 1;
        }
      }
      return expired;
    },
  };
}
