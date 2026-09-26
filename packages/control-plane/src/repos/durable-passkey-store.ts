import type {
  ChallengeMeta,
  PasskeyChallengeStore,
  PasskeyCredential,
  PasskeyCredentialStore,
} from "@opensesame/auth-upstream";
import type { Database } from "@opensesame/database";
import { DurableMap } from "./durable-map.js";

export function durablePasskeyCredentials(
  db: Database,
): PasskeyCredentialStore {
  const store = new DurableMap<PasskeyCredential>(
    db,
    "OpenSesame:PasskeyCredential",
    false,
    null,
  );
  return {
    get: (id) => store.get(id),
    create: (record) => store.claim(record.credentialId, record),
    advance: async (id, counter) => {
      let advanced = false;
      await store.update(id, (current) => {
        if (!current) return undefined;
        if (counter === 0) {
          advanced = current.counter === 0;
          return current;
        }
        if (counter <= current.counter) return current;
        advanced = true;
        return { ...current, counter };
      });
      return advanced;
    },
    // Bounded by the store's capacity (DurableMap: 10,000 records).
    listByPrincipal: async (principalId) =>
      (await store.values()).filter(
        (record) => record.principalId === principalId,
      ),
    remove: (id) => store.delete(id),
  };
}

export function durablePasskeyChallenges(db: Database): PasskeyChallengeStore {
  const store = new DurableMap<ChallengeMeta>(
    db,
    "OpenSesame:PasskeyChallenge",
    true,
    300_000,
  );
  return {
    set: async (challenge, metadata) => {
      await store.set(challenge, metadata);
    },
    peek: async (challenge) => {
      const meta = await store.get(challenge);
      return meta && meta.expiresAt > Date.now() ? meta : undefined;
    },
    consume: async (challenge) => {
      const meta = await store.take(challenge);
      return meta && meta.expiresAt > Date.now() ? meta : undefined;
    },
  };
}
