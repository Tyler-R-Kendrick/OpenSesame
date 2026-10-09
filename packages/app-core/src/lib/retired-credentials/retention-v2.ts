/** Local-clock data policy only. Expiry does not erase stolen verifiers/backups. */
import { isString } from "@opensesame/os-domain";
import profile from "../../../../../spec/conformance/retired-retention-v2.json";
export const DEFAULT_RETIRED_RETENTION_MS = profile.defaultLifetimeMs;
export const MAX_RETIRED_RETENTION_MS = profile.maxLifetimeMs;
function invalid(): never {
  throw new Error("Invalid retired credential retention.");
}
function timestamp(raw: string): number {
  if (
    !isString(raw) ||
    raw.length !== 24 ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(raw)
  )
    invalid();
  const at = Date.parse(raw);
  if (!Number.isSafeInteger(at) || new Date(at).toISOString() !== raw)
    invalid();
  return at;
}
function clock(nowMs: number): void {
  if (!Number.isSafeInteger(nowMs)) invalid();
  try {
    timestamp(new Date(nowMs).toISOString());
  } catch {
    invalid();
  }
}
export function assertRetiredTrapRetention(
  createdAt: string,
  expiresAt: string,
): void {
  const created = timestamp(createdAt);
  const expires = timestamp(expiresAt);
  if (expires <= created || expires - created > MAX_RETIRED_RETENTION_MS)
    invalid();
}
/** Owner-selected duration; caller still needs genuine fresh-owner publication authority. */
export function retiredTrapExpiresAt(
  createdAt: string,
  lifetimeMs = DEFAULT_RETIRED_RETENTION_MS,
): string {
  if (
    !Number.isSafeInteger(lifetimeMs) ||
    lifetimeMs < 1 ||
    lifetimeMs > MAX_RETIRED_RETENTION_MS
  )
    invalid();
  const created = timestamp(createdAt);
  const expiresAt = new Date(created + lifetimeMs).toISOString();
  assertRetiredTrapRetention(createdAt, expiresAt);
  return expiresAt;
}
/** Not a permission or clock attestation. A backward clock can prolong eligibility. */
export function isRetiredTrapLive(
  createdAt: string,
  expiresAt: string,
  nowMs: number,
): boolean {
  clock(nowMs);
  assertRetiredTrapRetention(createdAt, expiresAt);
  return timestamp(createdAt) <= nowMs && nowMs < timestamp(expiresAt);
}
