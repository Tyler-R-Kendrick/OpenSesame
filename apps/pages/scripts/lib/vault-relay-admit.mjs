/**
 * Admission for the in-process relay. Same rules as `member_allows` and
 * `publish_allows` in `crates/gateway/src/vault_relay`.
 */

export const FORMAT = "opensesame-vault-drive-snapshot";

export function validSegment(value) {
  if (typeof value !== "string" || value === "guest") return false;
  if (value.length < 1 || value.length > 63) return false;
  if (value.startsWith("-") || value.endsWith("-")) return false;
  return /^[a-z0-9-]+$/.test(value);
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
  return (
    !!value &&
    typeof value === "object" &&
    value.format === FORMAT &&
    value.v === 1
  );
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
