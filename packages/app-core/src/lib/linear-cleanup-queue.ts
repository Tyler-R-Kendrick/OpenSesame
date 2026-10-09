/** Cleanup obligations are sealed before mutation and shared across consent and disconnect. */
import type { BoundaryValue } from "@opensesame/os-domain";
import { lockManager } from "../ports.js";
import {
  type LinearActor,
  type StoredLinearGrant,
  linearPublicRecord,
  parseLinearGrant,
  updateLinearRecord,
} from "./linear-store.js";

export const cleanupKey = (actor: LinearActor): string =>
  `linear_cleanup_${actor}`;
export const cleanupGrantId = (grant: StoredLinearGrant): string =>
  JSON.stringify([
    grant.kind,
    grant.accessToken,
    grant.refreshToken ?? null,
    grant.expiresAt,
    grant.scopes,
  ]);
function parseQueue(raw: string): StoredLinearGrant[] {
  const values: BoundaryValue = JSON.parse(raw);
  if (!Array.isArray(values) || values.length > 32)
    throw new Error(
      "Linear cleanup record could not be read; credentials were retained",
    );
  return values.map((value: BoundaryValue) => {
    const grant = parseLinearGrant(JSON.stringify(value));
    if (!grant)
      throw new Error(
        "Linear cleanup record could not be read; credentials were retained",
      );
    return grant;
  });
}
export function cleanupQueue(raw?: string): StoredLinearGrant[] {
  if (!raw) return [];
  try {
    return parseQueue(raw);
  } catch {
    throw new Error(
      "Linear cleanup record could not be read; credentials were retained",
    );
  }
}
export function distinctCleanup(
  grants: StoredLinearGrant[],
): StoredLinearGrant[] {
  const pending = new Map(
    grants.map((grant) => [cleanupGrantId(grant), grant]),
  );
  if (pending.size > 32)
    throw new Error(
      "Linear cleanup retry limit reached; credentials were retained",
    );
  return [...pending.values()];
}
export async function retainCleanupGrant(
  id: string,
  actor: LinearActor,
  grant: StoredLinearGrant,
): Promise<void> {
  await updateLinearRecord(id, async (record, runtime) => {
    const key = cleanupKey(actor);
    const pending = distinctCleanup([
      ...cleanupQueue(record.secrets[key]),
      grant,
    ]);
    return linearPublicRecord(
      {
        ...record,
        secrets: { ...record.secrets, [key]: JSON.stringify(pending) },
      },
      runtime,
    );
  });
}
export async function forgetCleanedGrants(
  id: string,
  actor: LinearActor,
  cleaned: Set<string>,
): Promise<void> {
  await updateLinearRecord(id, async (record, runtime) => {
    const key = cleanupKey(actor);
    const pending = cleanupQueue(record.secrets[key]).filter(
      (item) => !cleaned.has(cleanupGrantId(item)),
    );
    const secrets = { ...record.secrets };
    if (pending.length) secrets[key] = JSON.stringify(pending);
    else Reflect.deleteProperty(secrets, key);
    return linearPublicRecord({ ...record, secrets }, runtime);
  });
}

const cleanupRuns = new Map<string, Promise<void>>();
/** This separate lease allows each rotation to take the atomic storage lock. */
export async function withLinearCleanup<T>(
  id: string,
  actor: LinearActor,
  action: () => Promise<T>,
): Promise<T> {
  const name = `opensesame:linear-cleanup:${id}:${actor}`;
  const previous = cleanupRuns.get(name) ?? Promise.resolve();
  const result = previous.then(async () => {
    const locks = lockManager();
    return locks ? locks.request(name, action) : action();
  });
  const settled = result.then(
    () => undefined,
    () => undefined,
  );
  cleanupRuns.set(name, settled);
  try {
    return await result;
  } finally {
    if (cleanupRuns.get(name) === settled) cleanupRuns.delete(name);
  }
}
