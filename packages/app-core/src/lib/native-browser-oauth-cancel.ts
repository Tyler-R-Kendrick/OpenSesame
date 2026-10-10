/** A dismissed consent window removes only its own unexchanged pending request. */
import { browserOAuthClassification } from "./native-browser-oauth-profile.js";
import { updateNativeConnector } from "./native-connector-store.js";
import {
  nativeOAuthGuard,
  requireNativeOAuthRecord,
} from "./native-oauth-session.js";
export async function cancelNativeBrowserConsent(
  id: string,
  state: string,
): Promise<void> {
  const record = requireNativeOAuthRecord(id);
  const actor = Object.keys(record.privateState.pending).find(
    (key) => record.privateState.pending[key]?.state === state,
  );
  if (!actor) return;
  await updateNativeConnector(
    id,
    nativeOAuthGuard(record),
    browserOAuthClassification(record.configuration),
    (current) => {
      if (current.privateState.pending[actor]?.state !== state) return current;
      const { [actor]: _cancelled, ...remaining } =
        current.privateState.pending;
      current.privateState.pending = remaining;
      return current;
    },
  );
}
