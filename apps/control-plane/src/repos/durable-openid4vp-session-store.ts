/**
 * Durable OpenID4VP request-session store (ADR 0125).
 */

import type { Database } from "@opensesame/database";
import {
  type AuthorizationRequest,
  Openid4vpError,
  type RequestSessionRecord,
  type RequestSessionStore,
} from "@opensesame/openid4vp";
import { DurableMap } from "./durable-map.js";

export class DurableOpenid4vpSessionStore implements RequestSessionStore {
  private readonly rows: DurableMap<RequestSessionRecord>;

  constructor(db: Database) {
    this.rows = new DurableMap(db, "OpenSesame:Openid4vpSession", false, null);
  }

  async create(request: AuthorizationRequest): Promise<void> {
    const existing = await this.rows.get(request.state);
    if (existing) {
      throw new Openid4vpError("presentation_replayed", "session_lookup");
    }
    await this.rows.set(request.state, { request, consumedAt: null });
  }

  async lookup(state: string): Promise<RequestSessionRecord | null> {
    return (await this.rows.get(state)) ?? null;
  }

  async consume(state: string, at: Date): Promise<boolean> {
    let won = false;
    await this.rows.update(state, (current) => {
      if (!current || current.consumedAt !== null) return current;
      won = true;
      return { request: current.request, consumedAt: at };
    });
    return won;
  }
}
