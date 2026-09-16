import { refuseAccessDomain } from "./realm.js";

/**
 * The longest a temporary domain may run, in milliseconds.
 *
 * Thirty days matches the outer edge of a claims-flow engagement. Past that a
 * caller is describing an estate, not a visit, and should create a standard
 * domain that someone has to decide to remove.
 */
export const MAX_TEMPORARY_DOMAIN_LIFETIME_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Whether a domain is on a clock.
 *
 * Tagged the same way the Rust `DomainLifetime` serializes, so one JSON
 * document describes a domain on either plane.
 */
export type DomainLifetime =
  | { readonly kind: "permanent" }
  | { readonly kind: "temporary"; readonly expiresAt: Date };

export const PERMANENT: DomainLifetime = { kind: "permanent" };

export function temporaryUntil(expiresAt: Date): DomainLifetime {
  return { kind: "temporary", expiresAt };
}

/** The deadline, if there is one. Metadata only — never a value. */
export function deadlineOf(lifetime: DomainLifetime): Date | undefined {
  return lifetime.kind === "temporary" ? lifetime.expiresAt : undefined;
}

export function isTemporary(lifetime: DomainLifetime): boolean {
  return lifetime.kind === "temporary";
}

export function isExpired(lifetime: DomainLifetime, now: Date): boolean {
  const deadline = deadlineOf(lifetime);
  return deadline !== undefined && now.getTime() >= deadline.getTime();
}

/**
 * The check that actually stops access.
 *
 * The `lifecycle.*` feed (ADR 0074) announces a deadline to subscribers; it is
 * never what enforces one, so a scanner that misses a tick cannot extend
 * anybody's reach.
 */
export function assertLifetimeActive(
  lifetime: DomainLifetime,
  now: Date,
): void {
  if (!isExpired(lifetime, now)) return;
  throw refuseAccessDomain("expired", "Access domain has expired");
}

/** Whether a lifetime is sane for a domain created at `createdAt`. */
export function assertLifetimeWellFormed(
  lifetime: DomainLifetime,
  createdAt: Date,
): void {
  const deadline = deadlineOf(lifetime);
  if (deadline === undefined) return;
  const span = deadline.getTime() - createdAt.getTime();
  if (span <= 0) {
    throw refuseAccessDomain(
      "lifetime",
      "Temporary domain expires at or before it is created",
    );
  }
  if (span > MAX_TEMPORARY_DOMAIN_LIFETIME_MS) {
    throw refuseAccessDomain(
      "lifetime",
      `Temporary domain lifetime exceeds ${MAX_TEMPORARY_DOMAIN_LIFETIME_MS} ms`,
    );
  }
}

/**
 * Whether `child` is admissible directly beneath `parent`.
 *
 * Two rules, and both exist because a deadline you can escape by nesting is not
 * a deadline: nothing permanent hangs under something temporary, and a child
 * never outlives its parent.
 */
export function assertLifetimeWithin(
  child: DomainLifetime,
  parent: DomainLifetime,
): void {
  const parentDeadline = deadlineOf(parent);
  if (parentDeadline === undefined) return;
  const childDeadline = deadlineOf(child);
  if (childDeadline === undefined) {
    throw refuseAccessDomain(
      "lifetime",
      "A permanent domain cannot hang under a temporary one",
    );
  }
  if (childDeadline.getTime() > parentDeadline.getTime()) {
    throw refuseAccessDomain(
      "lifetime",
      "A child domain cannot outlive its parent",
    );
  }
}

/**
 * The lifetime `child` becomes under `parent`: the earlier of the two
 * deadlines.
 *
 * Callers use this to propose a legal lifetime. The forest never applies it
 * implicitly — silently shortening a caller's deadline is as surprising as
 * silently extending it, so the forest refuses and the caller decides.
 */
export function narrowedTo(
  child: DomainLifetime,
  parent: DomainLifetime,
): DomainLifetime {
  const parentDeadline = deadlineOf(parent);
  if (parentDeadline === undefined) return child;
  const childDeadline = deadlineOf(child);
  if (childDeadline === undefined) return temporaryUntil(parentDeadline);
  return temporaryUntil(
    childDeadline.getTime() <= parentDeadline.getTime()
      ? childDeadline
      : parentDeadline,
  );
}
