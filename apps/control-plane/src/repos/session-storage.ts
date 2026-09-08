import type { ProvisionalSession } from "@opensesame/os-domain";
import type { AppStores } from "../state.js";
import { DurableMap } from "./durable-map.js";

async function deleteTokenEntry(stores: AppStores, key: string): Promise<void> {
  const tokens = stores.provisionalTokens;
  if (tokens instanceof DurableMap) await tokens.deleteEntry(key);
  else tokens.delete(key);
}

export async function saveProvisional(
  stores: AppStores,
  session: ProvisionalSession,
  token: string,
): Promise<void> {
  await stores.provisionalSessions.set(session.id, session);
  await stores.provisionalTokens.set(token, session.id);
}

export async function removeOrphanTokens(stores: AppStores): Promise<void> {
  for (const [token, id] of await stores.provisionalTokens.entries()) {
    if (!(await stores.provisionalSessions.has(id)))
      await deleteTokenEntry(stores, token);
  }
}

export async function revokeSessionTokens(
  stores: AppStores,
  sessionId: string,
): Promise<void> {
  for (const [token, id] of await stores.provisionalTokens.entries()) {
    if (id === sessionId) await deleteTokenEntry(stores, token);
  }
}
