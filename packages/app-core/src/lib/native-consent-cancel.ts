/** Cancel only the pending consent owned by this attempt, before a token exchange. */
import type { NativeFieldClassification } from "./native-connector-schema.js";
import {
  loadNativeConnectorRecord,
  updateNativeConnector,
} from "./native-connector-store.js";
import { nativeOAuthGuard } from "./native-oauth-session.js";

export async function discardNativeConsent(
  id: string,
  state: string,
  classification: NativeFieldClassification,
): Promise<void> {
  const record = loadNativeConnectorRecord(id);
  if (!record) return;
  const actor = Object.keys(record.privateState.pending).find(
    (key) => record.privateState.pending[key]?.state === state,
  );
  if (!actor) return;
  await updateNativeConnector(
    id,
    nativeOAuthGuard(record),
    classification,
    (current) => {
      if (current.privateState.pending[actor]?.state === state)
        delete current.privateState.pending[actor];
      return current;
    },
  );
}
