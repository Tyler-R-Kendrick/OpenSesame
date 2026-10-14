import { aiDelegationAvailable } from "@opensesame/app-core/lib/ai-connections/delegation.js";
import {
  bindModelKeyBroker,
  notifyModelKeys,
} from "@opensesame/app-core/lib/model-keys/active.js";
import { clearModelKeyAuditEvents } from "@opensesame/app-core/lib/model-keys/audit-ring.js";
import { ModelKeyBroker } from "@opensesame/app-core/lib/model-keys/broker.js";
import { pageModelKeyPorts } from "@opensesame/app-core/lib/model-keys/page-ports.js";
import {
  type BrokerPolicy,
  type ConnectionFacts,
  DEFAULT_POLICY,
} from "@opensesame/app-core/lib/model-keys/types.js";
import { readNativeConnector } from "@opensesame/app-core/lib/native-connector-store.js";
/**
 * Model keys (ADR 0192): the broker that stands between an app or an agent and
 * a saved model provider's credential. Only External connectors reads native
 * authority, so only this file tells the broker which saved connections are
 * real; the broker itself holds no credential and writes nothing to disk.
 */
import { onVaultLock } from "@opensesame/app-core/lib/vault/lock-events.js";
import type { Activation } from "../activation.js";

/**
 * A page cannot attach a proof key to a request it did not make, and a key
 * held in memory dies with the tab, so a key here need not be bound to a
 * sender (ADR 0192 §4). A deployment that reaches the broker over a channel
 * that can sign asks for `dpop_required` instead.
 */
export const PAGE_POLICY: BrokerPolicy = {
  ...DEFAULT_POLICY,
  senderConstraint: "dpop_optional",
};

/** A saved connection can back a key only when it is a verified API key. */
export function connectionFacts(connectionId: string): ConnectionFacts | null {
  const view = readNativeConnector(connectionId);
  if (!view) return null;
  // These records hold actual-vault references and may select custom hosts or
  // Responses. The closed delegation broker only admits its compiled contracts.
  if (view.configuration.parameters.ai_contract === "ai-connection-v1")
    return aiDelegationAvailable(connectionId)
      ? { connectionId, providerId: view.providerId, verified: true }
      : null;
  return {
    connectionId,
    providerId: view.providerId,
    verified:
      view.status === "connected" && view.configuration.method === "api-key",
  };
}

export function bindNativeModelKeys(activation: Activation): ModelKeyBroker {
  const broker = new ModelKeyBroker(
    pageModelKeyPorts({ connection: connectionFacts }),
    PAGE_POLICY,
  );
  activation.onDispose(bindModelKeyBroker(broker));
  // The trail describes keys that no longer exist once the broker is released.
  activation.onDispose(clearModelKeyAuditEvents);
  // A lock ends every key: the credential behind them is sealed again.
  activation.onDispose(
    onVaultLock(() => {
      broker.reset();
      clearModelKeyAuditEvents();
      notifyModelKeys();
    }),
  );
  return broker;
}
