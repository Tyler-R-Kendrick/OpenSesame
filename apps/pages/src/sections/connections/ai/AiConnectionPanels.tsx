import type { Flash } from "@opensesame/app-core/sections/connections/shared.js";
import { FailureNotice } from "../../../components/FailureNotice.js";
import { IconKey } from "../../../components/IconKey.js";
import { IconX } from "../../../components/Icons.js";
import { ConnectorPanel } from "../connect/ConnectorPanel.js";
import "../connect/connect.css";
import { AiConnectionForm } from "./AiConnectionForm.js";
import { AiDelegationPanel } from "./AiDelegationPanel.js";
import { AiInferenceWorkspace } from "./AiInferenceWorkspace.js";
import { useAiConnection } from "./useAiConnection.js";

export type AiConnectionPanelsProps = {
  providerId: string;
  connectionId?: string;
  onFlash: (flash: Flash) => void;
  onChanged?: () => void;
  inSheet?: boolean;
};

export function AiConnectionPanels({
  providerId,
  connectionId,
  onFlash,
  onChanged,
  inSheet = false,
}: AiConnectionPanelsProps) {
  const state = useAiConnection(providerId, connectionId, onFlash, onChanged);
  if (inSheet)
    return <AiConnectionForm {...state} saved={state.hasSavedCredentials} />;
  return (
    <div className="cx-setup">
      <ConnectorPanel
        step={2}
        label="AI configuration"
        title={state.savedId ? "Configure" : "Connect"}
        focus
        actions={
          state.hasSavedCredentials ? (
            <IconKey
              label="Forget AI connection"
              disabled={state.busy}
              onClick={state.onForget}
            >
              <IconX size={16} />
            </IconKey>
          ) : null
        }
      >
        <AiConnectionForm {...state} saved={state.hasSavedCredentials} />
      </ConnectorPanel>
      {state.savedId && state.hasSavedCredentials ? (
        <>
          <AiInferenceWorkspace
            key={state.savedId}
            connectionId={state.savedId}
          />
          <AiDelegationPanel connectionId={state.savedId} />
        </>
      ) : null}
      <FailureNotice
        id={`ai-connection-${providerId}`}
        title="AI connection"
        message={state.failure}
      />
    </div>
  );
}
