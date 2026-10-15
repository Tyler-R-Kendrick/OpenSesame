/** A GitHub operation belongs to one approved plan and one captured vault session. */
import { z } from "zod";
import { maybePage, sessionStore } from "../ports.js";
import { backupOriginAllowed } from "./backup-egress-gate.js";
import { assertLeaseCurrent } from "./capabilities/lease.js";
import { compositionStore } from "./capabilities/store.js";
import type { GithubDirectTransport } from "./github-app-direct.js";
import { GithubDirectError } from "./github-app-signing.js";
import { localVaultSessionGuard } from "./secret-backends/local-vault-port.js";
import { GUEST_TOMB, vaultStore } from "./vault/store.js";

let generation = 0;
const active = new Set<AbortController>();
const STATE = "opensesame.github-app.state";
const TRANSACTION = "opensesame.github-app.registration";
const transactionSchema = z.object({
  state: z.string().min(1),
  ownerTomb: z.string().min(1).nullable(),
  returnUrl: z.string().url(),
  createdAt: z.number().int().nonnegative(),
});

export function startGithubRegistration(
  state: string,
  returnUrl: string,
): void {
  invalidateGithubAppAuthority();
  const snapshot = vaultStore.getSnapshot();
  const ownerTomb =
    snapshot.guest || snapshot.tomb === GUEST_TOMB ? null : snapshot.tomb;
  sessionStore().setItem(
    TRANSACTION,
    JSON.stringify({ state, ownerTomb, returnUrl, createdAt: Date.now() }),
  );
  sessionStore().setItem(STATE, state);
}

/** Consume once, bound to the vault and callback chosen before leaving this app. */
export function consumeGithubRegistration(state: string) {
  if (!state || sessionStore().getItem(STATE) !== state) return null;
  const raw = sessionStore().getItem(TRANSACTION);
  sessionStore().removeItem(STATE);
  sessionStore().removeItem(TRANSACTION);
  try {
    const transaction = transactionSchema.parse(JSON.parse(raw ?? "null"));
    const age = Date.now() - transaction.createdAt;
    const snapshot = vaultStore.getSnapshot();
    const location = maybePage()?.location;
    const callback = new URL(transaction.returnUrl);
    if (
      transaction.state !== state ||
      age < 0 ||
      age > 3600000 ||
      (transaction.ownerTomb !== null &&
        (snapshot.guest || snapshot.tomb !== transaction.ownerTomb)) ||
      (location &&
        (callback.origin !== location.origin ||
          callback.pathname !== location.pathname))
    )
      return null;
    return transaction;
  } catch {
    return null;
  }
}

/** Remove cancels claims even when no public App record has landed yet. */
export function invalidateGithubAppAuthority(): void {
  generation += 1;
  for (const controller of active) controller.abort();
  sessionStore().removeItem(STATE);
  sessionStore().removeItem(TRANSACTION);
}

type GithubAuthorityOptions = {
  /** Manifest conversion has no PEM input; its returned secret waits only in memory. */
  allowBeforeVault?: boolean;
  binding?: () => boolean;
};

export function captureGithubAuthority(options: GithubAuthorityOptions = {}) {
  const lease = compositionStore.currentLease();
  const snapshot = vaultStore.getSnapshot();
  const owned =
    snapshot.status === "unlocked" &&
    !snapshot.guest &&
    snapshot.tomb !== GUEST_TOMB;
  if (!owned && !options.allowBeforeVault)
    throw new GithubDirectError(
      "configuration",
      "Unlock the vault that holds this GitHub App key.",
    );
  const vault = owned ? localVaultSessionGuard(vaultStore) : null;
  const lifetime = new AbortController();
  const capturedGeneration = generation;
  const signal = AbortSignal.any([lease.signal, lifetime.signal]);
  const onLock = vaultStore.onLock(() => lifetime.abort());
  active.add(lifetime);
  const transport: GithubDirectTransport = {
    signal,
    assertCurrent() {
      signal.throwIfAborted();
      assertLeaseCurrent(
        lease,
        compositionStore.getSnapshot().generation,
        "backup.git-remote",
      );
      if (!backupOriginAllowed("https://api.github.com"))
        throw new GithubDirectError(
          "authorization",
          "The operator's policy does not allow GitHub access.",
        );
      if (generation !== capturedGeneration || options.binding?.() === false)
        throw new GithubDirectError(
          "cancelled",
          "This GitHub App operation is no longer current.",
        );
      if (vault) vault.current();
      else {
        const current = vaultStore.getSnapshot();
        if (current.tomb !== snapshot.tomb || current.guest !== snapshot.guest)
          throw new GithubDirectError(
            "cancelled",
            "The active vault changed during GitHub registration.",
          );
      }
    },
    fetch: (input, init) => globalThis.fetch(input, init),
  };
  const close = () => {
    lifetime.abort();
    active.delete(lifetime);
    onLock();
    vault?.close();
  };
  try {
    transport.assertCurrent();
    return { transport, tomb: snapshot.guest ? null : snapshot.tomb, close };
  } catch (error) {
    close();
    throw error;
  }
}
