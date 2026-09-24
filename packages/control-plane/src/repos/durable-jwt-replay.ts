import { createHash } from "node:crypto";
import type { Database } from "@opensesame/database";
import type { JwtReplayCache } from "@opensesame/oauth-provider";
import { DurableMap, type SecurityMap } from "./durable-map.js";

type ReplayEntry = { expiresAt: number };

function replayKey(issuer: string, jti: string): string {
  return createHash("sha256")
    .update(issuer)
    .update("\n")
    .update(jti)
    .digest("hex");
}

/**
 * Replica-shared `private_key_jwt` jti fence. `DurableMap.claim` is the
 * compare-and-swap: the first replica to record `(issuer, jti)` wins.
 */
export function createDurableJwtReplayCache(
  db: Database,
): DurableJwtReplayCache {
  return new DurableJwtReplayCache(
    new DurableMap(db, "OpenSesame:JwtReplay", false, 86_400_000),
  );
}

export class DurableJwtReplayCache implements JwtReplayCache {
  constructor(private readonly store: SecurityMap<ReplayEntry>) {}

  async remember(
    issuer: string,
    jti: string,
    expiresAtMs: number,
  ): Promise<boolean> {
    const key = replayKey(issuer, jti);
    const entry = { expiresAt: expiresAtMs };
    if (this.store instanceof DurableMap) {
      return this.store.claim(key, entry);
    }
    const existing = this.store.get(key);
    if (existing !== undefined && existing.expiresAt > Date.now()) return false;
    this.store.set(key, entry);
    return true;
  }
}
