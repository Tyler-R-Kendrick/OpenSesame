/**
 * Admission for the in-process relay. Same rules as `member_allows` and
 * `publish_allows` in `crates/gateway/src/vault_relay`.
 */
import { z } from "zod";

export const FORMAT = "opensesame-vault-drive-snapshot";
const segmentSchema = z
  .string()
  .min(1)
  .max(63)
  .regex(/^[a-z0-9]+(?:[a-z0-9-]*[a-z0-9])?$/)
  .refine((value) => value !== "guest");
const snapshotSchema = z
  .object({ format: z.literal(FORMAT), v: z.literal(1) })
  .passthrough();

export function validSegment(value) {
  return segmentSchema.safeParse(value).success;
}

export function addressOf(owner, slug) {
  if (!validSegment(owner) || !validSegment(slug)) return null;
  return `${owner}/${slug}`;
}

export function knownRole(role) {
  return (
    role === "" || role === "owner" || role === "admin" || role === "member"
  );
}

export function memberAllows(action, ownerKind, principal, owner, role) {
  if (ownerKind === "user") {
    if (action === "list") return principal === "" || principal === owner;
    return principal === owner;
  }
  if (ownerKind !== "organization") return false;
  if (action === "list") return true;
  return role !== "member";
}

export function publishAllows(ownerKind, principal, owner, role) {
  if (ownerKind === "user") return principal === "" || principal === owner;
  if (ownerKind !== "organization") return false;
  return role !== "member";
}

export function snapshotOk(value) {
  return snapshotSchema.safeParse(value).success;
}

export function presentedKey(raw) {
  if (!raw) return null;
  const bytes = Buffer.from(raw, "base64url");
  if (bytes.length !== 32) return null;
  return raw;
}

export function remember(directory, address, ownerKind, principal) {
  const [owner, slug] = address.split("/");
  const current = directory.get(address);
  if (current) {
    current.ownerKind = ownerKind;
    if (principal) current.principal = principal;
    return;
  }
  directory.set(address, {
    ownerKind,
    owner: owner ?? "",
    slug: slug ?? "",
    principal,
  });
}
