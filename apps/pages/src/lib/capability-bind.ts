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
 * runs the consent round trip for the connectors that need Host authorization.
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
import { ensureHostSession } from "./identity.js";
import { loadSettings, saveSettings } from "./settings.js";

export const capabilityBindDependencies = {
  ensureHostSession,
  listConnections,
  createConnection,
  authorizeConnection,
  awaitConsent,
  loadSettings,
  saveSettings,
};

export type BindOutcome = {
  tone: "ok" | "warn" | "err";
  text: string;
};

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
    if (previous.remote) next.remote = previous.remote;
  }
  capabilityBindDependencies.saveSettings({
    ...current,
    capabilityConnectors: { ...current.capabilityConnectors, [id]: next },
  });
  return next;
}

/** True when this binding still owes a Host authorization before it works. */
export function bindingNeedsAuth(
  id: CapabilityId,
  binding: CapabilityConnectorBinding,
): boolean {
  return (
    capabilityDef(id).requiresAuth(binding.providerId) && !binding.connectionId
  );
}

/**
 * Run the consent round trip and record the resulting connection.
 *
 * The popup is opened by the caller, on the click gesture, and handed in:
 * browsers only allow `window.open` synchronously from a user action, and this
 * function has to await a Host session before it knows where to send it.
 */
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
    await capabilityBindDependencies.ensureHostSession();
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

    if (outcome.result === "active") {
      persistConnectionId(id, outcome.connection.connectionId);
      return { tone: "ok", text: `${label} authorized.` };
    }
    if (outcome.result === "failed") {
      return {
        tone: "err",
        text:
          outcome.connection.statusDetail ?? `${label} refused authorization.`,
      };
    }
    // Not finished is not failed: the connection exists and can be resumed, so
    // remember it rather than making the next attempt start from nothing.
    persistConnectionId(id, connection.connectionId);
    return {
      tone: "warn",
      text: "Consent was not finished. You can authorize again from here.",
    };
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

function persistConnectionId(id: CapabilityId, connectionId: string): void {
  const current = capabilityBindDependencies.loadSettings();
  const binding = current.capabilityConnectors[id];
  capabilityBindDependencies.saveSettings({
    ...current,
    capabilityConnectors: {
      ...current.capabilityConnectors,
      [id]: { ...binding, connectionId },
    },
  });
}
