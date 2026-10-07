import { createItem, manualPassword } from "@opensesame/vault-core";
import {
  assertAuthenticationSession,
  assertDecoySession,
  currentRealmGeneration,
  setDecoyInteractionObserver,
} from "../decoy-session.js";
import { setActivePresentation } from "../duress/compartment/presentation-runtime.js";
/** Fresh independent synthetic realm. No duress incident or owner snapshots. */
import { createKeyedCompartment } from "../duress/compartment/registry.js";
import { projectScopedView } from "../duress/compartment/scope.js";
import {
  mintPresentationSession,
  openPresentation,
} from "../duress/compartment/session.js";
import {
  type RetiredCredentialTrap,
  recordRetiredDecoyInteraction,
} from "./index.js";
import type { RetiredCredentialSessionStore } from "./session-types.js";

export async function openRetiredCredentialDecoy(
  store: RetiredCredentialSessionStore,
  trap: RetiredCredentialTrap,
  tomb: string,
): Promise<void> {
  const authorityGeneration = assertAuthenticationSession();
  if (!store.addItems) throw new Error("Synthetic realm unavailable.");
  store.cancelTotpChallenge?.();
  const account = createItem("account", "Example account");
  account.username = "member@example.invalid";
  const password = `synthetic-${crypto.randomUUID()}`;
  account.uris = [
    {
      id: `${account.id}:uri`,
      uri: "https://account.example.invalid",
      match: "domain",
    },
  ];
  account.methods = [
    manualPassword(`${account.id}:password`, password, account.createdAt),
  ];
  const profileId = `retired:${trap.id}`;
  const compartment = await createKeyedCompartment({
    compartmentRef: `compartment:${profileId}`,
    kind: "decoy",
    label: "Personal",
    keyEpoch: 1,
    items: [
      {
        id: account.id,
        title: account.name,
        folder: "Personal",
        secret: password,
        preview: "https://account.example.invalid",
      },
    ],
  });
  try {
    assertAuthenticationSession(authorityGeneration);
    const session = await mintPresentationSession({
      presentation: "decoy",
      profileId,
      contextId: `retired:${crypto.randomUUID()}`,
      admittedKeys: [
        {
          compartmentRef: compartment.compartmentRef,
          keyEpoch: 1,
          rawKey: compartment.rawKey,
        },
      ],
    });
    assertAuthenticationSession(authorityGeneration);
    const outcome = await openPresentation(session, compartment, {
      expectKind: "decoy",
    });
    assertAuthenticationSession(authorityGeneration);
    if (outcome.kind !== "opened")
      throw new Error("Synthetic realm unavailable.");
    const creating = store.createGuest({
      decoy: true,
      resume: false,
      isolated: true,
    });
    const syntheticGeneration = currentRealmGeneration();
    await creating;
    assertDecoySession(syntheticGeneration);
    await store.addItems([account]);
    assertDecoySession(syntheticGeneration);
    setDecoyInteractionObserver((action) => {
      void recordRetiredDecoyInteraction(tomb, trap.id, action);
    });
    setActivePresentation({
      storeOwnsView: true,
      profileId,
      outcome,
      view: projectScopedView(outcome),
    });
  } finally {
    compartment.rawKey.fill(0);
  }
}
