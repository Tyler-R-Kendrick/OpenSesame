/**
 * Host opaque ids (crates/domain opaque_id) for shared-session grants.
 *
 * Pages tombs and vault items are local UUIDs (or `prj_<uuid>`). Host grants
 * speak `vault:…` / `item:…` / `principal:…`. These helpers normalize without
 * inventing a second identity plane.
 */

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function bareUuid(raw: string): string | null {
  const trimmed = raw.trim();
  if (UUID.test(trimmed)) return trimmed.toLowerCase();
  const prefixed = trimmed.match(
    /^(?:vault|item|principal|session|sgrant|joinreq):([0-9a-f-]{36})$/i,
  );
  if (prefixed?.[1] && UUID.test(prefixed[1])) return prefixed[1].toLowerCase();
  const project = trimmed.match(/^prj_([0-9a-f-]{36})$/i);
  if (project?.[1] && UUID.test(project[1])) return project[1].toLowerCase();
  return null;
}

/** Deterministic UUID from an arbitrary tomb slug (personal / guest / …). */
async function digestUuid(seed: string): Promise<string> {
  const bytes = new TextEncoder().encode(`opensesame.vault:${seed}`);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  // Version 8 (custom) / RFC 4122 variant — stable, not time-ordered.
  const b6 = digest[6] ?? 0;
  const b8 = digest[8] ?? 0;
  digest[6] = (b6 & 0x0f) | 0x80;
  digest[8] = (b8 & 0x3f) | 0x80;
  const hex = [...digest.subarray(0, 16)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function hostPrincipalId(raw: string): string | null {
  const uuid = bareUuid(raw);
  return uuid ? `principal:${uuid}` : null;
}

export function hostItemId(raw: string): string | null {
  const uuid = bareUuid(raw);
  return uuid ? `item:${uuid}` : null;
}

export async function hostVaultIdForTomb(tomb: string): Promise<string> {
  const uuid = bareUuid(tomb) ?? (await digestUuid(tomb.trim() || "personal"));
  return `vault:${uuid}`;
}

export function hostSessionKey(sessionId: string): string | null {
  return bareUuid(sessionId);
}

export function isHostPrincipalId(raw: string): boolean {
  return hostPrincipalId(raw) !== null;
}
