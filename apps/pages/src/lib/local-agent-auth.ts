import { isString } from "@opensesame/os-domain";
import { randomString, sha256Base64Url } from "@opensesame/sdk-browser";
import {
  type LocalAgentChallenge,
  verifyLocalAgentChallenge,
} from "@opensesame/static-auth";
import {
  type LocalAgentKey,
  agentKeyMaterial,
  readLocalAgentKeys,
  requireLocalAgent,
} from "./local-agent-keys.js";
import {
  LocalDirectoryError,
  withLocalDirectoryLock,
} from "./local-directory.js";
import type { LocalAuthentication } from "./local-passkeys.js";
import { vaultStore } from "./vault/store.js";

type Pending = {
  tomb: string;
  challenge: LocalAgentChallenge;
  key: LocalAgentKey;
  directoryRevision: number;
  deadline: number;
};
let pending = new Map<string, Pending>();
let evidenceSet = new WeakSet<LocalAuthentication>();
vaultStore.onLock(() => {
  pending = new Map();
  evidenceSet = new WeakSet();
});
function refused(): never {
  throw new LocalDirectoryError(
    "This agent proof is unavailable. Start a new challenge.",
  );
}
function live(item: Pending) {
  if (
    location.origin !== item.challenge.origin ||
    Date.now() >= item.challenge.expiresAt ||
    performance.now() >= item.deadline
  )
    refused();
}

/** One bounded, origin/key/principal-bound challenge. It grants no authority. */
export async function beginLocalAgentAuthentication(
  tomb: string,
  principalId: string,
  credentialId: string,
): Promise<LocalAgentChallenge> {
  const queue = pending;
  const origin = location.origin;
  return withLocalDirectoryLock(tomb, async () => {
    const directory = await requireLocalAgent(tomb, principalId);
    const key = (await readLocalAgentKeys(tomb)).find(
      (row) =>
        row.principalId === principalId && row.credentialId === credentialId,
    );
    if (!key) refused();
    await agentKeyMaterial(key);
    for (const [digest, item] of queue) {
      if (
        Date.now() >= item.challenge.expiresAt ||
        performance.now() >= item.deadline
      )
        queue.delete(digest);
    }
    if (queue !== pending || origin !== location.origin || queue.size >= 128)
      refused();
    const challenge = Object.freeze({
      nonce: randomString(32),
      principalId,
      keyId: key.keyId,
      origin,
      expiresAt: Date.now() + 120_000,
    });
    const deadline = performance.now() + 120_000;
    const digest = await sha256Base64Url(challenge.nonce);
    if (queue !== pending || origin !== location.origin || queue.size >= 128)
      refused();
    queue.set(digest, {
      tomb,
      challenge,
      key,
      directoryRevision: directory.revision,
      deadline,
    });
    return challenge;
  });
}

/** Nonces are spent before signature verification, including failed attempts. */
export async function authenticateLocalAgent(
  tomb: string,
  nonce: string,
  proof: string,
): Promise<LocalAuthentication> {
  if (
    !isString(nonce) ||
    !/^[A-Za-z0-9_-]{43}$/.test(nonce) ||
    !isString(proof) ||
    proof.length > 8192
  )
    refused();
  const digest = await sha256Base64Url(nonce);
  const queue = pending;
  const item = queue.get(digest);
  if (!item || item.tomb !== tomb) refused();
  queue.delete(digest);
  return withLocalDirectoryLock(tomb, async () => {
    live(item);
    const directory = await requireLocalAgent(tomb, item.challenge.principalId);
    const key = (await readLocalAgentKeys(tomb)).find(
      (row) =>
        row.credentialId === item.key.credentialId &&
        row.principalId === item.key.principalId,
    );
    if (
      !key ||
      directory.revision !== item.directoryRevision ||
      key.publicKeyB64 !== item.key.publicKeyB64 ||
      key.createdAt !== item.key.createdAt
    )
      refused();
    try {
      await verifyLocalAgentChallenge(
        proof,
        item.challenge,
        (await agentKeyMaterial(key)).publicKey,
      );
    } catch {
      refused();
    }
    live(item);
    if (queue !== pending) refused();
    const evidence: LocalAuthentication = Object.freeze({
      tomb,
      principalId: key.principalId,
      credentialId: key.credentialId,
      credentialCreatedAt: key.createdAt,
      publicKeyB64: key.publicKeyB64,
      directoryRevision: directory.revision,
      authTime: Date.now(),
      origin: item.challenge.origin,
      amr: Object.freeze(["signed_challenge"]),
    });
    evidenceSet.add(evidence);
    return evidence;
  });
}

export function consumeLocalAgentAuthentication(
  evidence: LocalAuthentication,
): LocalAuthentication {
  if (
    !evidenceSet.delete(evidence) ||
    evidence.origin !== location.origin ||
    Date.now() < evidence.authTime ||
    Date.now() - evidence.authTime >= 120_000
  )
    refused();
  return evidence;
}

/** At most 128 pending challenges; cancellation carries no authentication power. */
export function cancelLocalAgentAuthentication(
  tomb: string,
  nonce: string,
): void {
  for (const [digest, item] of pending) {
    if (item.tomb === tomb && item.challenge.nonce === nonce)
      pending.delete(digest);
  }
}
