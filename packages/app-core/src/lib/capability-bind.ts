/**
 * Binding a capability to a connector, and authorizing it — without a panel.
 *
 * This logic used to live only inside `CapabilityConnectorsPanel`, tangled up
 * with that component's `providers` / `connections` / `flash` state. That made
 * it unreachable from anywhere else, which is why the key-vault ceremony could
 * only ever link to the panel instead of doing the work: the code to do the
 * work was not callable.
 *
 * So the sequence lives here. Two entry points, both usable from any surface:
 * `bindCapabilityConnector` writes the choice, and `authorizeCapabilityConnector`
 * runs the consent round trip for the connectors that need authorization.
 *
 * Encryption/root-protection readiness is stricter than other capabilities
 * (KP-14/KP-15): a pending/resumable `connectionId` is not authorized, and a
 * consent callback captured against a prior provider/vault/generation is
 * discarded rather than written into the current selection.
 */

import {
  type CapabilityConnectorBinding,
  type CapabilityId,
  capabilityDef,
  connectorLabel,
} from "./capabilities.js";
import {
  authorizeConnection,
  awaitConsent,
  createConnection,
  listConnections,
} from "./connections.js";
import { readLastVaultId } from "./last-vault.js";
import { loadSettings, saveSettings } from "./settings.js";

/** Host consent readiness for a capability binding (C11 / KP-14). */
export type ConnectionAuthorizationState =
  | "missing"
  | "pending"
  | "authorized"
  | "expired";

/** Immutable capture taken when consent starts — late callbacks must match. */
export type ConsentOperationCapture = {
  operationGeneration: number;
  vaultScope: string;
  providerId: string;
  capabilityId: CapabilityId;
  connectionConfig: {
    connectionId: string;
    remote?: string;
  };
};

export const capabilityBindDependencies = {
  listConnections,
  createConnection,
  authorizeConnection,
  awaitConsent,
  loadSettings,
  saveSettings,
  /** Vault scope at consent time / callback validation (KP-15). */
  resolveVaultScope: (): string => readLastVaultId() ?? "personal",
};

export type BindOutcome = {
  tone: "ok" | "warn" | "err";
  text: string;
};

/** Monotonic generation; bumps when selection changes mid-consent (KP-15). */
let operationGeneration = 0;

export function currentConsentOperationGeneration(): number {
  return operationGeneration;
}

/** Call when vault/provider selection changes while consent may be in flight. */
export function bumpConsentOperationGeneration(): number {
  operationGeneration += 1;
  return operationGeneration;
}

/**
 * Persist a capability → connector choice.
 *
 * Changing the provider drops any `connectionId`, because a connection is an
 * authorization of one specific provider: carrying GitHub's consent over to a
 * GitLab binding would claim an approval nobody gave.
 */
export function bindCapabilityConnector(
  id: CapabilityId,
  providerId: string,
): CapabilityConnectorBinding {
  const current = capabilityBindDependencies.loadSettings();
  const previous = current.capabilityConnectors[id];
  const next: CapabilityConnectorBinding = { providerId };
  if (previous.providerId === providerId) {
    if (previous.connectionId) next.connectionId = previous.connectionId;
    if (previous.authorization) next.authorization = previous.authorization;
    if (previous.remote) next.remote = previous.remote;
  } else {
    bumpConsentOperationGeneration();
  }
  capabilityBindDependencies.saveSettings({
    ...current,
    capabilityConnectors: { ...current.capabilityConnectors, [id]: next },
  });
  return next;
}

/**
 * Resolve consent readiness. For encryption, a nonempty `connectionId` alone
 * is never `authorized` (KP-14). Other capabilities keep legacy behavior:
 * `connectionId` without an explicit state counts as authorized.
 */
export function connectionAuthorizationState(
  id: CapabilityId,
  binding: CapabilityConnectorBinding,
): ConnectionAuthorizationState {
  if (!capabilityDef(id).requiresAuth(binding.providerId)) {
    return "authorized";
  }
  if (binding.authorization === "expired") return "expired";
  if (!binding.connectionId) {
    return binding.authorization === "pending" ? "pending" : "missing";
  }
  if (id === "encryption") {
    if (binding.authorization === "authorized") return "authorized";
    if (binding.authorization === "pending") return "pending";
    // Bare connectionId from unfinished consent or legacy data ≠ protecting.
    return "pending";
  }
  if (binding.authorization === "pending") return "pending";
  if (binding.authorization === "authorized") return "authorized";
  // Non-encryption legacy: connectionId present ⇒ treated as authorized.
  return "authorized";
}

/** True when this binding still owes a Host authorization before it works. */
export function bindingNeedsAuth(
  id: CapabilityId,
  binding: CapabilityConnectorBinding,
): boolean {
  if (!capabilityDef(id).requiresAuth(binding.providerId)) return false;
  return connectionAuthorizationState(id, binding) !== "authorized";
}

/**
 * True when encryption/root protection may use this binding as authorized
 * connector material — stricter than `!bindingNeedsAuth` for non-encryption.
 */
export function bindingAuthorizedForRootProtection(
  binding: CapabilityConnectorBinding,
): boolean {
  return connectionAuthorizationState("encryption", binding) === "authorized";
}

function connectionConfigSnapshot(
  binding: CapabilityConnectorBinding,
  connectionId: string,
): ConsentOperationCapture["connectionConfig"] {
  const snapshot: ConsentOperationCapture["connectionConfig"] = {
    connectionId,
  };
  if (binding.remote) snapshot.remote = binding.remote;
  return snapshot;
}

export function captureConsentOperation(
  id: CapabilityId,
  binding: CapabilityConnectorBinding,
  connectionId: string,
): ConsentOperationCapture {
  return {
    operationGeneration: currentConsentOperationGeneration(),
    vaultScope: capabilityBindDependencies.resolveVaultScope(),
    providerId: binding.providerId,
    capabilityId: id,
    connectionConfig: connectionConfigSnapshot(binding, connectionId),
  };
}

/** KP-15: reject when provider, vault, remote, or generation diverged. */
export function consentCaptureIsCurrent(
  capture: ConsentOperationCapture,
): boolean {
  if (capture.operationGeneration !== currentConsentOperationGeneration()) {
    return false;
  }
  if (capture.vaultScope !== capabilityBindDependencies.resolveVaultScope()) {
    return false;
  }
  const binding =
    capabilityBindDependencies.loadSettings().capabilityConnectors[
      capture.capabilityId
    ];
  if (binding.providerId !== capture.providerId) return false;
  const expectedRemote = capture.connectionConfig.remote ?? "";
  const actualRemote = binding.remote ?? "";
  return expectedRemote === actualRemote;
}

/**
 * Run the consent round trip and record the resulting connection.
 *
 * The popup is opened by the caller, on the click gesture, and handed in:
 * browsers only allow `window.open` synchronously from a user action, and this
 * function has to await a Host session before it knows where to send it.
 */

function bindOutcomeFromConsent(
  id: CapabilityId,
  label: string,
  connectionId: string,
  outcome: Awaited<ReturnType<typeof capabilityBindDependencies.awaitConsent>>,
): BindOutcome {
  if (outcome.result === "active") {
    persistConnectionBinding(id, outcome.connection.connectionId, "authorized");
    return { tone: "ok", text: `${label} authorized.` };
  }
  if (outcome.result === "failed") {
    clearConnectionBinding(id);
    return {
      tone: "err",
      text:
        outcome.connection.statusDetail ?? `${label} refused authorization.`,
    };
  }
  persistConnectionBinding(id, connectionId, "pending");
  return {
    tone: "warn",
    text: "Consent was not finished. You can authorize again from here.",
  };
}

export async function authorizeCapabilityConnector(
  id: CapabilityId,
  popup: Window | null,
): Promise<BindOutcome> {
  const def = capabilityDef(id);
  const settings = capabilityBindDependencies.loadSettings();
  const binding = settings.capabilityConnectors[id];
  const label = connectorLabel(binding.providerId);

  if (!def.requiresAuth(binding.providerId)) {
    popup?.close();
    return { tone: "ok", text: `${label} needs no authorization.` };
  }

  try {
    const scopes = def.authScopes?.(binding.providerId);
    const existing = (await capabilityBindDependencies.listConnections()).find(
      (entry) =>
        entry.connectionId === binding.connectionId ||
        entry.providerId === binding.providerId,
    );
    const connection =
      existing && existing.status !== "revoked"
        ? existing
        : await capabilityBindDependencies.createConnection({
            providerId: binding.providerId,
            displayName: label,
            scopes,
          });

    // Resumable id may be recorded as pending, but is not yet authorized.
    persistConnectionBinding(id, connection.connectionId, "pending");

    const capture = captureConsentOperation(
      id,
      binding,
      connection.connectionId,
    );

    const { authorizationUrl } =
      await capabilityBindDependencies.authorizeConnection(
        connection.connectionId,
        scopes,
      );
    if (popup) popup.location.href = authorizationUrl;
    else window.location.href = authorizationUrl;

    const outcome = await capabilityBindDependencies.awaitConsent(
      connection.connectionId,
      popup,
    );

    if (!consentCaptureIsCurrent(capture)) {
      popup?.close();
      const current =
        capabilityBindDependencies.loadSettings().capabilityConnectors[id];
      if (
        current.authorization === "pending" &&
        current.connectionId === capture.connectionConfig.connectionId
      ) {
        clearConnectionBinding(id);
      }
      return {
        tone: "warn",
        text: "Authorization finished for a previous selection and was discarded.",
      };
    }

    return bindOutcomeFromConsent(id, label, connection.connectionId, outcome);
  } catch (error) {
    popup?.close();
    return {
      tone: "err",
      text:
        error instanceof Error
          ? error.message
          : "Could not authorize this connector.",
    };
  }
}

function persistConnectionBinding(
  id: CapabilityId,
  connectionId: string,
  authorization: ConnectionAuthorizationState,
): void {
  const current = capabilityBindDependencies.loadSettings();
  const binding = current.capabilityConnectors[id];
  const next: CapabilityConnectorBinding = {
    providerId: binding.providerId,
    connectionId,
    authorization,
  };
  if (binding.remote) next.remote = binding.remote;
  if (binding.selections) next.selections = binding.selections;
  capabilityBindDependencies.saveSettings({
    ...current,
    capabilityConnectors: {
      ...current.capabilityConnectors,
      [id]: next,
    },
  });
}

/** Drop a refused or abandoned connection id without changing the provider. */
function clearConnectionBinding(id: CapabilityId): void {
  const current = capabilityBindDependencies.loadSettings();
  const binding = current.capabilityConnectors[id];
  const next: CapabilityConnectorBinding = { providerId: binding.providerId };
  if (binding.remote) next.remote = binding.remote;
  if (binding.selections) next.selections = binding.selections;
  capabilityBindDependencies.saveSettings({
    ...current,
    capabilityConnectors: {
      ...current.capabilityConnectors,
      [id]: next,
    },
  });
}
