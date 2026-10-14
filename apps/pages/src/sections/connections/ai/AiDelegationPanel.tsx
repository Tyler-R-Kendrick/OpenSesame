import { aiDelegationAvailable } from "@opensesame/app-core/lib/ai-connections/delegation.js";
import { readAiConnection } from "@opensesame/app-core/lib/ai-connections/store.js";
import {
  modelKeysVersion,
  subscribeModelKeys,
} from "@opensesame/app-core/lib/model-keys/active.js";
import { useSyncExternalStore } from "react";
import { ModelKeysPanel } from "./keys/ModelKeysPanel.js";

/** The same backend admission check controls whether the existing key UI is offered. */
export function AiDelegationPanel({ connectionId }: { connectionId: string }) {
  useSyncExternalStore(subscribeModelKeys, modelKeysVersion, modelKeysVersion);
  const draft = readAiConnection(connectionId);
  if (!draft || !aiDelegationAvailable(connectionId)) return null;
  return (
    <ModelKeysPanel
      providerId={draft.providerId}
      providerName={draft.name}
      connectionId={connectionId}
    />
  );
}
