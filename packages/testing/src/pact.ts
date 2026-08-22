import type { BoundaryValue, JsonObject } from "@opensesame/os-domain";
/**
 * Property / Adversarial / Chaos / conTract helpers (see docs/validation/pact.md).
 */

/** Run `worker` concurrently and return how many times it reported success. */
export async function countConcurrentWins(
  worker: () => Promise<boolean> | boolean,
  n = 32,
): Promise<number> {
  const results = await Promise.all(
    Array.from({ length: n }, () => Promise.resolve().then(worker)),
  );
  return results.filter(Boolean).length;
}

/** Exclusive claim: only one concurrent caller may succeed. */
export async function assertExclusiveClaim(
  worker: () => Promise<boolean> | boolean,
  n = 32,
): Promise<void> {
  const wins = await countConcurrentWins(worker, n);
  if (wins !== 1) {
    throw new Error(`pact exclusive claim: expected 1 winner, got ${wins}`);
  }
}

/** Capacity fence: concurrent callers may succeed at most `max` times. */
export async function assertAtMostWins(
  worker: () => Promise<boolean> | boolean,
  max: number,
  n = 32,
): Promise<number> {
  const wins = await countConcurrentWins(worker, n);
  if (wins > max) {
    throw new Error(`pact capacity: expected at most ${max} wins, got ${wins}`);
  }
  return wins;
}

/**
 * Check-then-set mutant: two observers both see "absent" then both write.
 * Used to prove why the production path must not be a naked read/write.
 */
export function checkThenSetAdmitsDoubleClaim(): void {
  const keys = new Set<string>();
  const check = (key: string) => !keys.has(key);
  const set = (key: string) => {
    keys.add(key);
  };
  const c1 = check("d1");
  const c2 = check("d1");
  if (!(c1 && c2)) {
    throw new Error("pact mutant: expected both checks to pass");
  }
  set("d1");
  set("d1");
}

/** Production source must mention markers in order (mutation oracle). */
export function assertSourceOrder(src: string, ordered: string[]): void {
  const production =
    src.split("#[cfg(test)]")[0]?.split("\ndescribe(")[0] ?? src;
  let last = 0;
  for (const marker of ordered) {
    const pos = production.indexOf(marker, last);
    if (pos < 0) {
      throw new Error(`pact source oracle missing ${marker}`);
    }
    last = pos;
  }
}

const DEFAULT_SECRET_FIELDS = [
  "access_token",
  "refresh_token",
  "client_secret",
  "webhook_secret",
  "private_key",
  "claim_token",
  "claimToken",
] as const;

/** Contract: a JSON body must not carry secret-shaped keys (except `allow`). */
export function assertNoSecretFields(
  value: BoundaryValue,
  allow: readonly string[] = [],
): void {
  const allowed = new Set(allow);
  const blob = JSON.stringify(value);
  for (const leak of DEFAULT_SECRET_FIELDS) {
    if (allowed.has(leak)) continue;
    if (blob.includes(`"${leak}"`)) {
      throw new Error(`pact contract: secret field ${leak} present`);
    }
  }
}

/** Contract: documented HTTP statuses must include fail-closed codes. */
export function assertFailClosedStatuses(
  responses: JsonObject | undefined,
  required: string[] = ["401"],
): void {
  if (!responses) {
    throw new Error("pact contract: missing responses object");
  }
  for (const code of required) {
    if (!(code in responses)) {
      throw new Error(`pact contract: missing fail-closed status ${code}`);
    }
  }
}

/** Chaos: after a publish/partition failure, durable work must still be present. */
export async function assertDurableSurvivesPartition(
  durableCount: () => Promise<number> | number,
  publish: () => Promise<void>,
): Promise<void> {
  try {
    await publish();
  } catch {
    // partition is the scenario under test
  }
  const n = await durableCount();
  if (n < 1) {
    throw new Error("pact chaos: durable work dropped after partition");
  }
}
